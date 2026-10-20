import { describe, it, expect, vi } from 'vitest';
import { approvals, deals, events, hunts, jobs, mandates, openDb, verifications, type Mandate } from '@proxydeal/core';
import type { FoAdapter, FoInbound } from '@proxydeal/fo';
import { Store } from '../apps/proxy/src/store.js';
import type { Config } from '../apps/proxy/src/config.js';

process.env.MODEL_CHEAP ??= 'test-model';
process.env.MODEL_ORCHESTRATOR ??= 'test-model';

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
const { HANDLERS, competitionProblem } = await import('../apps/proxy/src/handlers.js');
const { pollInbound } = await import('../apps/proxy/src/inbound.js');

const silent = { info() {}, warn() {}, error() {} } as never;
const mandate: Mandate = {
  floorOrCeiling: 300, openingOffer: 220, maxConcessionPerRound: 40, walkAwayAt: 6,
  dealbreakers: [], allowedShare: [], neverShare: ['ceiling'], secrets: {},
};
const cfg: Config = {
  proxyId: 'dev', role: 'buyer', owner: 'Dev', ownerPhone: '+14155550000', counterparty: { name: 'Agent 1' },
  foMcpUrl: '', foOauthPort: 0, port: 0, dbPath: ':memory:', mockFo: true, workerIntervalMs: 1000, timeScale: 1,
  ownerNotifyPhone: '+14155550101', allowPayments: false, foAutoConfirm: true, inboundPollMs: 10_000,
};
const A = { id: 'PD-AAAA01', name: 'Arasha', phone: '+15105550101' };
const B = { id: 'PD-BBBB02', name: 'Bo', phone: '+15105550202' };

function setup(hunted = true) {
  const db = openDb(':memory:');
  if (hunted) db.insert(hunts).values({ id: 'H-TEST01', item: 'Sayl chair', createdAt: '2026-10-19T16:00:00Z' }).run();
  for (const s of [A, B]) {
    db.insert(deals).values({
      id: s.id, role: 'buyer', item: 'Sayl chair', stage: 'NEGOTIATING', status: 'active', channelPref: 'text',
      counterparty: { name: s.name, kind: 'human', phone: s.phone }, createdAt: '2026-10-19T16:00:00Z', huntId: hunted ? 'H-TEST01' : null,
    }).run();
    db.insert(mandates).values({ dealId: s.id, data: mandate }).run();
  }
  const store = new Store(db, silent);
  const fo = {
    act: vi.fn(async () => ({ foTaskId: 't1', status: { state: 'complete', artifacts: [] } })),
    pay: vi.fn(),
    inbound: vi.fn(async () => [] as FoInbound[]),
    transcript: vi.fn(async () => []),
  } as unknown as FoAdapter;
  const ctx = (id: string) => ({ store, fo, cfg, dealId: id });
  return { db, store, fo, ctx };
}

describe('talking to several sellers', () => {
  it('blocks invented competition when there is no other seller', () => {
    const { ctx } = setup(false);
    expect(competitionProblem(ctx(A.id), "I've got another seller at $240, can you match it?")).toMatch(/no other live seller/);
    expect(competitionProblem(ctx(A.id), 'is the chair still available?')).toBeUndefined();
  });

  it("lets a real competing offer be cited, never a better one than it is", () => {
    const { store, ctx } = setup();
    store.addOffer(B.id, 'counterparty', 245, '', '');
    expect(competitionProblem(ctx(A.id), "honestly I've got another offer at $245.")).toBeUndefined();
    expect(competitionProblem(ctx(A.id), 'another seller is at $250, so')).toBeUndefined(); // understating is fine
    expect(competitionProblem(ctx(A.id), 'another seller is at $230.')).toMatch(/\$230/);
    // Our own counter in a different sentence is not a claim about the other seller.
    expect(competitionProblem(ctx(A.id), "I'm talking to another seller too. Could you do $235?", 235)).toBeUndefined();
  });

  it('shows the owner the other sellers when asking to sign off, one decision at a time', async () => {
    const { db, store, ctx } = setup();
    store.addOffer(B.id, 'counterparty', 245, '', '');
    await HANDLERS.request_approval(ctx(A.id), { tier: 2, summary: 'Arasha accepts $260, Wed 5:45.', payload: { kind: 'accept', amount: 260 } });
    const row = db.select().from(approvals).all()[0];
    expect(row.summary).toContain('Other sellers: Bo at $245 (negotiating)');
    await expect(HANDLERS.request_approval(ctx(B.id), { tier: 2, summary: 'Bo at $245', payload: { kind: 'accept', amount: 245 } }))
      .rejects.toThrow(/deciding on Arasha's offer/);
  });

  it('when one seller wins, the others can no longer close and are told to wrap up politely', async () => {
    const { db, store, ctx } = setup();
    db.insert(verifications).values({ dealId: A.id, stage: 'NEGOTIATING', expected: 'x', observed: 'x', passed: true, evidence: '[]', ts: '2026-10-19T17:00:00Z' }).run();
    db.insert(approvals).values({ dealId: A.id, tier: 2, summary: 's', payload: { kind: 'accept', amount: 260 }, payloadHash: 'h', status: 'approved', createdAt: '2026-10-19T17:00:00Z' }).run();
    await HANDLERS.transition(ctx(A.id), { to: 'AGREED', reason: 'Arasha accepted $260' });
    expect(store.hunt('H-TEST01')?.winnerDealId).toBe(A.id);
    expect(db.select().from(events).all().some((e) => e.dealId === B.id && e.kind === 'HuntLost')).toBe(true);
    expect(db.select().from(jobs).all().some((j) => j.dealId === B.id && j.type === 'turn' && JSON.stringify(j.payload).includes('went with another seller'))).toBe(true);
    store.addOffer(B.id, 'counterparty', 240, '', '');
    await expect(HANDLERS.propose(ctx(B.id), { amount: 240, accept: true, terms: '', rationale: '', message: 'deal', channel: 'text' })).rejects.toThrow(/already has a deal with Arasha/);
    await expect(HANDLERS.transition(ctx(B.id), { to: 'AGREED', reason: 'x' })).rejects.toThrow(/already has a deal with Arasha|verify/);
  });

  it("routes a group thread to the right seller when both got the same opener", async () => {
    const { store, fo } = setup();
    for (const s of [A, B]) store.event(s.id, 'FoAction', 'fo', { script: "Hi! this is Dev's AI assistant, is the Sayl still available?", foConversationId: `x-${s.id}` });
    vi.mocked(fo.inbound).mockResolvedValueOnce([{ conversationId: 'g-b', channel: 'sms', title: `Group with ${B.phone}`, startedAt: '2026-10-19T16:05:00Z',
      turns: [{ role: 'assistant', text: "Hi! this is Dev's AI assistant, is the Sayl still available?", at: '2026-10-19T16:05:00Z' }] }]);
    await pollInbound(store, fo, cfg);
    const reg = store.db.select().from(events).all().filter((e) => e.kind === 'GroupThread');
    expect(reg.map((e) => e.dealId)).toEqual([B.id]);
  });
});
