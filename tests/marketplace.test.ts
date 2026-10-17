import { describe, it, expect, vi } from 'vitest';
import { approvals, deals, events, jobs, mandates, openDb, type Mandate } from '@proxydeal/core';
import type { FoAdapter, FoInbound } from '@proxydeal/fo';
import { Store } from '../apps/proxy/src/store.js';
import type { Config } from '../apps/proxy/src/config.js';

process.env.MODEL_CHEAP ??= 'test-model';
process.env.MODEL_ORCHESTRATOR ??= 'test-model';

// Every model call (inbound extraction) gets a canned "nothing found" reply; the leak guard passes (trust.test.ts covers it).
vi.mock('@proxydeal/llm', async (orig) => ({
  ...(await orig<typeof import('@proxydeal/llm')>()),
  guardOutbound: async (o: { script: string }) => ({ ok: true, script: o.script, removed: [] }),
  anthropic: () => ({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ offerAmount: null, accepts: false, optOut: false, leak: false, what: [] }) }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    },
  }),
}));
const { pollInbound, readOwnerDecision, isOwnerThread } = await import('../apps/proxy/src/inbound.js');
const { HANDLERS } = await import('../apps/proxy/src/handlers.js');
const { Worker } = await import('../apps/proxy/src/worker.js');

const silent = { info() {}, warn() {}, error() {} } as never;
const OWNER = '+1 (415) 555-0101';
const SELLER = '+14155550199';
const mandate: Mandate = {
  floorOrCeiling: 950, openingOffer: 700, maxConcessionPerRound: 100, walkAwayAt: 6,
  dealbreakers: [], allowedShare: [], neverShare: ['ceiling'], secrets: {},
};

const cfg: Config = {
  proxyId: 'dev', role: 'buyer', owner: 'Dev', ownerPhone: '+14155550000', counterparty: { name: 'Agent 1' },
  foMcpUrl: '', foOauthPort: 0, port: 0, dbPath: ':memory:', mockFo: true, workerIntervalMs: 1000, timeScale: 1,
  ownerNotifyPhone: OWNER, allowPayments: false,
};

function setup() {
  const db = openDb(':memory:');
  db.insert(deals).values({
    id: 'PD-BIKE01', role: 'buyer', item: 'e-bike', stage: 'NEGOTIATING', status: 'active', channelPref: 'text',
    counterparty: { name: 'Maya', kind: 'human', phone: SELLER }, createdAt: '2026-10-17T19:00:00Z',
  }).run();
  db.insert(mandates).values({ dealId: 'PD-BIKE01', data: mandate }).run();
  const store = new Store(db, silent);
  const sent: { to: string; script: string }[] = [];
  const fo = {
    act: vi.fn(async (r: { to: string; script: string }) => { sent.push(r); return { foTaskId: `t${sent.length}`, status: { state: 'complete', artifacts: [] } }; }),
    pay: vi.fn(),
    inbound: vi.fn(async () => [] as FoInbound[]),
  } as unknown as FoAdapter;
  return { store, fo, sent, ctx: { store, fo, cfg, dealId: 'PD-BIKE01' } };
}

const sms = (id: string, title: string, text: string, at = '2026-10-17T20:00:00Z'): FoInbound =>
  ({ conversationId: id, channel: 'sms', title, startedAt: at, turns: [{ role: 'user', text, at }] });

describe('owner replies by text', () => {
  it('reads YES / NO / instructions', () => {
    expect(readOwnerDecision('Yes')).toEqual({ decision: 'approved' });
    expect(readOwnerDecision('yep, but pickup at 11')).toEqual({ decision: 'approved', note: 'but pickup at 11' });
    expect(readOwnerDecision('no')).toEqual({ decision: 'denied' });
    expect(readOwnerDecision('try $850 first')).toEqual({ decision: 'denied', note: 'try $850 first' });
    expect(readOwnerDecision('nice try').decision).toBe('denied');
  });

  it("recognises the owner's thread by number, however Fo formats it", () => {
    const { store } = setup();
    const open = store.openDeals();
    expect(isOwnerThread(store, cfg, open, sms('c1', 'Text with 415-555-0101', 'yes'))).toBe(true);
    expect(isOwnerThread(store, cfg, open, sms('c2', `From ${SELLER}`, 'still available'))).toBe(false);
  });

  it('a YES text approves the pending sign-off and resumes the deal', async () => {
    const { store, fo, sent, ctx } = setup();
    const r = await HANDLERS.request_approval(ctx, { tier: 2, summary: 'Maya accepts $900 with the sofa, Sat 10am. OK?', payload: { kind: 'accept', amount: 900 } }) as { ownerTexted: boolean };
    expect(r.ownerTexted).toBe(true);
    expect(sent[0].to).toBe(OWNER);
    expect(store.deal('PD-BIKE01')!.status).toBe('paused');

    vi.mocked(fo.inbound).mockResolvedValueOnce([sms('c-owner', `From ${OWNER}`, 'YES')]);
    await pollInbound(store, fo, cfg);
    expect(store.db.select().from(approvals).get()!.status).toBe('approved');
    expect(store.deal('PD-BIKE01')!.status).toBe('active');
    // The owner's words never count as the seller's.
    expect(store.db.select().from(events).all().some((e) => e.kind === 'InboundMessage')).toBe(false);
  });

  it("the seller's texts go to their deal by phone number, not to approvals", async () => {
    const { store, fo } = setup();
    vi.mocked(fo.inbound).mockResolvedValueOnce([sms('c-seller', `From ${SELLER}`, 'yes it is still available!')]);
    await pollInbound(store, fo, cfg);
    const inbound = store.db.select().from(events).all().filter((e) => e.kind === 'InboundMessage');
    expect(inbound).toHaveLength(1);
    expect((inbound[0].data as { from: string }).from).toBe('Maya');
  });
});

describe('owner sign-off is enforced in code', () => {
  it('cannot accept a price without the owner approving that exact price', async () => {
    const { store, ctx } = setup();
    store.addOffer('PD-BIKE01', 'counterparty', 900, '', '');
    await expect(HANDLERS.propose(ctx, { amount: 900, accept: true, terms: '', rationale: '', message: "Hi, this is Dev's AI assistant. deal!", channel: 'text' }))
      .rejects.toThrow(/signs off on every final price/);
  });

  it('an approved sign-off for that price lets the accept through the gate', async () => {
    const { store, ctx } = setup();
    store.addOffer('PD-BIKE01', 'counterparty', 900, '', '');
    store.db.insert(approvals).values({ dealId: 'PD-BIKE01', tier: 2, summary: 'ok', payload: { kind: 'accept', amount: 900, items: ['bike', 'sofa'] }, payloadHash: 'x', status: 'approved', createdAt: 't' }).run();
    const r = await HANDLERS.propose(ctx, { amount: 900, accept: true, terms: 'sat 10am', rationale: '', message: "Hi, this is Dev's AI assistant. deal at $900!", channel: 'text' }) as { offerId: number };
    expect(r.offerId).toBeGreaterThan(0);
  });

  it('cannot move to AGREED without a sign-off', async () => {
    const { store, ctx } = setup();
    store.db.$client.prepare("INSERT INTO verifications (deal_id, stage, expected, observed, passed, evidence, ts) VALUES ('PD-BIKE01','NEGOTIATING','x','x',1,'[]','t')").run();
    await expect(HANDLERS.transition(ctx, { to: 'AGREED', reason: 'agreed' })).rejects.toThrow(/has not signed off/);
  });
});

describe('marketplace calls', () => {
  it('negotiate live but never finalize: the owner signs off and the agent confirms by text', async () => {
    const { liveCallRules } = await import('../apps/proxy/src/handlers.js');
    const { ctx } = setup();
    const rules = liveCallRules(ctx, mandate).join('\n');
    expect(rules).toMatch(/Do not finalize/);
    expect(rules).toMatch(/confirm with Dev and I'll text you right back/);
    expect(rules).toMatch(/Never send, request or accept money/);
    expect(rules).not.toMatch(/binding agreement/);
  });
});

describe('no real money', () => {
  it('refuses to pay even with an approved tier-3 approval when payments are off', async () => {
    const { store, fo } = setup();
    const a = store.db.insert(approvals).values({ dealId: 'PD-BIKE01', tier: 3, summary: 'pay', payload: { to: 'x', amount: 900, memo: '' }, payloadHash: '', status: 'approved', createdAt: 't' }).returning().get();
    store.db.insert(jobs).values({ dealId: 'PD-BIKE01', type: 'pay_execute', runAt: '2000-01-01T00:00:00Z', payload: { approvalId: a.id } }).run();
    // Only the pay job is due; run it.
    store.db.$client.prepare("UPDATE jobs SET status='done' WHERE type <> 'pay_execute'").run();
    await new Worker(store, fo, cfg).tick();
    expect(fo.pay).not.toHaveBeenCalled();
    expect(store.db.select().from(events).all().some((e) => e.kind === 'GuardBlocked' && /Payments are disabled/.test(JSON.stringify(e.data)))).toBe(true);
  });
});
