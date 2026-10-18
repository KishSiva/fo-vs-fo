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
  ownerNotifyPhone: OWNER, allowPayments: false, foAutoConfirm: true, inboundPollMs: 10_000,
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
    transcript: vi.fn(async () => [] as { role: string; text: string; at: string }[]),
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

describe('real Fo threads', () => {
  it("reads the owner's reply from Fo's own conversation, where Fo files it", async () => {
    const { store, fo, ctx } = setup();
    await HANDLERS.request_approval(ctx, { tier: 2, summary: 'Accept $900?', payload: { kind: 'accept', amount: 900 } });
    vi.mocked(fo.transcript).mockResolvedValue([
      { role: 'user', text: '[ProxyDeal PD-BIKE01] Send a text message to my owner...', at: '2026-10-18T00:24:03Z' },
      { role: 'assistant', text: 'SENT', at: '2026-10-18T00:24:21Z' },
      { role: 'user', text: 'ok', at: '2026-10-18T00:27:47Z' },
    ]);
    await pollInbound(store, fo, cfg);
    expect(store.db.select().from(approvals).get()!.status).toBe('approved');
    // Read once only.
    await pollInbound(store, fo, cfg);
    expect(store.db.select().from(events).all().filter((e) => e.kind === 'OwnerReply')).toHaveLength(1);
  });

  it('matches the seller thread by what we sent, even when Fo titles it with a contact name', async () => {
    const { store, fo } = setup();
    // A second, paused deal: the old "only one open deal" fallback no longer applies.
    store.db.insert(deals).values({ id: 'PD-OLD001', role: 'buyer', item: 'x', stage: 'NEGOTIATING', status: 'paused', counterparty: { name: 'Old', kind: 'human', phone: '+14155550111' }, createdAt: '2026-10-17T18:00:00Z' }).run();
    store.event('PD-BIKE01', 'FoAction', 'fo', { script: "Hi, this is Dev's AI assistant 👋 is the grey RadCity still available?", foConversationId: 'x' });
    vi.mocked(fo.inbound).mockResolvedValueOnce([{
      conversationId: 'c-named', channel: 'sms', title: 'Ryan Jacobs', startedAt: '2026-10-18T00:28:00Z',
      turns: [
        { role: 'assistant', text: "Hi, this is Dev's AI assistant 👋 is the grey RadCity still available?", at: '2026-10-18T00:28:24Z' },
        { role: 'user', text: 'yes! moving to NYC sunday', at: '2026-10-18T00:30:00Z' },
      ],
    }]);
    await pollInbound(store, fo, cfg);
    const inbound = store.db.select().from(events).all().filter((e) => e.kind === 'InboundMessage');
    expect(inbound.map((e) => e.dealId)).toEqual(['PD-BIKE01']);
  });
});

describe('group texts', () => {
  it('are registered and read through Fo, not blocked', async () => {
    const { store, fo } = setup();
    store.event('PD-BIKE01', 'FoAction', 'fo', { script: "Hi, this is Dev's AI assistant. Is the RadCity still available?", foConversationId: 'x' });
    vi.mocked(fo.inbound).mockResolvedValueOnce([{ conversationId: 'c-group', channel: 'sms', title: 'Group with +14155550199', startedAt: '2026-10-18T05:07:00Z',
      turns: [{ role: 'assistant', text: "Hi, this is Dev's AI assistant. Is the RadCity still available?", at: '2026-10-18T05:07:01Z' }] }]);
    await pollInbound(store, fo, cfg);
    expect(store.deal('PD-BIKE01')!.status).toBe('active');
    expect(store.db.select().from(events).all().filter((e) => e.kind === 'GroupThread')).toHaveLength(1);
  });

  it('a new deal with the same seller gets the shared group thread, even after an older deal registered it', async () => {
    const { store, fo } = setup();
    // The old deal (same number) registered the thread, then was abandoned.
    store.markProcessed('groupthread:PD-OLD001:c-group');
    store.markProcessed('groupthread:c-group');
    vi.mocked(fo.inbound).mockResolvedValueOnce([{ conversationId: 'c-group', channel: 'sms', title: 'Group with +14155550199', startedAt: '2026-10-18T05:07:00Z',
      turns: [{ role: 'assistant', text: 'opener from the old deal', at: '2026-10-18T05:07:01Z' }] }]);
    await pollInbound(store, fo, cfg);
    const reg = store.db.select().from(events).all().filter((e) => e.kind === 'GroupThread');
    expect(reg.map((e) => e.dealId)).toEqual(['PD-BIKE01']);
  });

  it("logs the seller's quoted lines, Fo's own replies and notes separately, and starts one turn", async () => {
    const { store, fo } = setup();
    const { readGroup } = await import('../apps/proxy/src/inbound.js');
    store.event('PD-BIKE01', 'FoAction', 'fo', { script: 'Is the RadCity still available?', foConversationId: 'x' });
    (fo as { quoteThread?: unknown }).quoteThread = vi.fn(async () => ({ readerConv: 'r1', messages: [
      { from: 'Fo', at: '05:07', text: 'Is the RadCity still available?' },
      { from: '+14155550199', at: '05:14', text: 'Still available, selling because I am moving.' },
      { from: 'Fo', at: '05:14', text: 'What are you asking for it?' },
      { from: 'Fo (note to owner)', at: '05:15', text: 'They are moving.' },
    ] }));
    await readGroup(store, fo, cfg, store.deal('PD-BIKE01')!, 'c-group', 'Group with +14155550199');
    await readGroup(store, fo, cfg, store.deal('PD-BIKE01')!, 'c-group', 'Group with +14155550199');
    const kinds = store.db.select().from(events).all().map((e) => e.kind);
    expect(kinds.filter((k) => k === 'InboundMessage')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'FoOwnMessage')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'FoNote')).toHaveLength(1);
    expect(store.db.select().from(jobs).all().filter((j) => j.type === 'turn')).toHaveLength(1);
  });

  it("gives Fo a counter ladder that stops short of the owner's real limit", async () => {
    const { counterLadder } = await import('../apps/proxy/src/handlers.js');
    const { steps, foCap } = counterLadder('buyer', mandate); // opening 700, ceiling 950
    expect(steps[0]).toBe(700);
    expect(foCap).toBeLessThan(950);
    expect(foCap % 5).not.toBe(0);
    expect(steps.every((n, i) => i === 0 || n > steps[i - 1])).toBe(true);
  });
});

describe('hand-off strategy', () => {
  const plan = (ladder: { amount: number; reason: string }[], extra: Record<string, unknown> = {}) => ({
    opener: "Hi, this is Dev's AI assistant! is the RadCity still available?", discovery: ['why selling?', 'deadline?'],
    interests: ['moving deadline: offer fast pickup'], ladder, trades: ['carry it out ourselves'], conditions: ['charger included'],
    checkWithOwner: ['before agreeing to any final price'], walkAway: 'thank them and step back', tone: 'casual', ...extra,
  });
  const withFo = () => {
    const env = setup();
    (env.fo as { brief?: unknown }).brief = vi.fn(async () => ({ foTaskId: 'b1', status: { state: 'complete', summary: 'Saved.', artifacts: [] } }));
    return env;
  };

  it('briefs Fo with the plan in one go and sends the opener', async () => {
    const { ctx, fo, sent, store } = withFo();
    const r = await HANDLERS.handoff_plan(ctx, plan([{ amount: 750, reason: 'comps' }, { amount: 820, reason: 'quick pickup' }, { amount: 867, reason: 'final' }])) as { handedOff: boolean };
    expect(r.handedOff).toBe(true);
    const briefText = vi.mocked(fo.brief).mock.calls[0][1];
    expect(briefText).toMatch(/PLAN \(from my negotiation agent/);
    expect(briefText).toMatch(/\$867: final/);
    expect(briefText).not.toMatch(/\$950/); // the real limit never reaches Fo
    expect(briefText).toMatch(/Use only the counter ladder in the plan above/); // no second, conflicting ladder
    expect(sent.at(-1)!.to).toBe(SELLER);
    expect(store.db.select().from(events).all().some((e) => e.kind === 'PlanHandedOff')).toBe(true);
  });

  it('with SHARE_PRIVATE_WITH_FO, Fo gets the private preferences marked secret and the ladder may reach the real limit', async () => {
    const { ctx, fo, store } = withFo();
    store.db.$client.prepare("UPDATE mandates SET data = json_set(data, '$.secrets', json('{\"target_price\":\"about $850\"}')) WHERE deal_id='PD-BIKE01'").run();
    const shared = { ...ctx, cfg: { ...cfg, sharePrivateWithFo: true } };
    await HANDLERS.handoff_plan(shared, plan([{ amount: 800, reason: 'x' }, { amount: 900, reason: 'y' }, { amount: 950, reason: 'final' }], { walkAway: 'never go above $950' }));
    const briefText = vi.mocked(fo.brief).mock.calls[0][1];
    expect(briefText).toMatch(/PRIVATE: for you only. Never say, hint at/);
    expect(briefText).toMatch(/Absolute maximum price: \$950/);
    expect(briefText).toMatch(/target price: about \$850/);
  });

  it("rejects a ladder past Fo's authority, oversized steps, or a plan that mentions the real limit", async () => {
    const { ctx, fo } = withFo();
    await expect(HANDLERS.handoff_plan(ctx, plan([{ amount: 940, reason: 'x' }]))).rejects.toThrow(/past Fo's authority/);
    await expect(HANDLERS.handoff_plan(ctx, plan([{ amount: 720, reason: 'x' }, { amount: 870, reason: 'y' }]))).rejects.toThrow(/more than the max/);
    await expect(HANDLERS.handoff_plan(ctx, plan([{ amount: 750, reason: 'x' }], { walkAway: 'never go above $950' }))).rejects.toThrow(/private information/);
    expect(vi.mocked(fo.brief)).not.toHaveBeenCalled();
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

describe("answering Fo's own go-ahead check", () => {
  const script = "Hi, this is Dev's AI assistant 👋 is the grey RadCity still available?";
  const holding = (words: string) => ({ state: 'complete' as const, artifacts: [], summary: `I have the text ready, but it's waiting on your go-ahead.\nExactly as it will read:\n> ${words}` });

  it('knows which messages commit to a deal', async () => {
    const { commitsToDeal } = await import('../apps/proxy/src/handlers.js');
    expect(commitsToDeal('NEGOTIATING', script)).toBe(false);
    expect(commitsToDeal('NEGOTIATING', 'would you take $800 if I grab the sofa too?')).toBe(false);
    expect(commitsToDeal('NEGOTIATING', 'ok $900 works, I accept!', false)).toBe(true);
    expect(commitsToDeal('NEGOTIATING', 'sure', true)).toBe(true);
    expect(commitsToDeal('AGREED', 'what time works saturday?')).toBe(true);
  });

  it('auto-approves a message that does not commit, when Fo holds exactly those words', async () => {
    const { ctx, fo, store } = setup();
    (fo as { reply?: unknown }).reply = vi.fn(async () => ({ state: 'complete', summary: 'Sent.', artifacts: [] }));
    const { autoConfirm } = await import('../apps/proxy/src/handlers.js');
    expect((await autoConfirm(ctx, 'c1', holding(script), script, 'text', false)).summary).toBe('Sent.');
    expect(vi.mocked(fo.reply)).toHaveBeenCalledWith('c1', expect.stringMatching(/Yes, approved by Dev/));
    expect(store.db.select().from(events).all().some((e) => e.kind === 'FoConfirmed')).toBe(true);
  });

  it('leaves commitments, mismatched words, and opted-out owners for a human', async () => {
    const { ctx, fo, store } = setup();
    (fo as { reply?: unknown }).reply = vi.fn();
    const { autoConfirm } = await import('../apps/proxy/src/handlers.js');
    const accept = "Hi, it's Dev's AI assistant. $900 works, deal!";
    await autoConfirm(ctx, 'c1', holding(accept), accept, 'text', true);
    await autoConfirm(ctx, 'c2', holding('Venmo me $900 now'), script, 'text', false);
    await autoConfirm({ ...ctx, cfg: { ...cfg, foAutoConfirm: false } }, 'c3', holding(script), script, 'text', false);
    expect(vi.mocked(fo.reply)).not.toHaveBeenCalled();
    const held = store.db.select().from(events).all().filter((e) => e.kind === 'FoHeld').map((e) => e.data as { canApprove: boolean; reason: string });
    expect(held.map((h) => h.canApprove)).toEqual([true, false, true]);
    expect(held[0].reason).toMatch(/commits to a deal/);
  });
});

describe('stalls', () => {
  it('a turn that keeps failing is retried later instead of leaving the deal with nothing scheduled', async () => {
    const { store, fo } = setup();
    store.db.insert(jobs).values({ dealId: 'PD-BIKE01', type: 'turn', runAt: '2000-01-01T00:00:00Z', attempts: 2, payload: { triggerId: 'kickoff', reason: 'start' } }).run();
    store.db.$client.prepare("UPDATE deals SET status='active'").run();
    const w = new Worker(store, fo, cfg);
    // Make the turn throw: no mandate means runTurn fails before calling the model.
    store.db.$client.prepare("DELETE FROM mandates").run();
    await w.tick();
    const pending = store.db.select().from(jobs).all().filter((j) => j.type === 'turn' && j.status === 'pending');
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as { triggerId: string }).triggerId).toBe('kickoff:retry1');
  });
});

describe('regressions from the Sam run', () => {
  it('does not auto-approve when only our own quoted message says "your OK", or when Fo already SENT it', async () => {
    const { ctx, fo } = setup();
    (fo as { reply?: unknown }).reply = vi.fn();
    const { autoConfirm } = await import('../apps/proxy/src/handlers.js');
    const q = "Quick check: I'll get your OK before accepting any price.";
    await autoConfirm(ctx, 'c1', { state: 'complete', artifacts: [], summary: `Here's the text:\n> ${q}` }, q, 'text', false);
    await autoConfirm(ctx, 'c2', { state: 'complete', artifacts: [], summary: `SENT\n\n"${q}" waiting on your go-ahead` }, q, 'text', false);
    expect(vi.mocked(fo.reply)).not.toHaveBeenCalled();
  });

  it("never reads the proxy's own approval message back as the owner's reply", async () => {
    const { store, fo, ctx } = setup();
    await HANDLERS.ask_owner(ctx, { question: 'Who sent the $1,200 text?' });
    store.markProcessed('ourreply:t1:Yes, approved by Dev. Send it now, exactly as written.');
    vi.mocked(fo.transcript).mockResolvedValue([
      { role: 'user', text: '[ProxyDeal] Send a text message to my owner...', at: '1' },
      { role: 'assistant', text: 'SENT', at: '2' },
      { role: 'user', text: 'Yes, approved by Dev. Send it now, exactly as written.', at: '3' },
    ]);
    await pollInbound(store, fo, cfg);
    expect(store.db.select().from(events).all().filter((e) => e.kind === 'OwnerReply')).toHaveLength(0);
  });

  it('repeating a number the other side said is not redacted as a leak', async () => {
    const { redactPrivate } = await import('../packages/llm/src/guards.js');
    const m = { ...mandate, floorOrCeiling: 1200 };
    expect(redactPrivate('so $1,200 with the charger, right? $1200 works to confirm', m, [1200]).removed).toEqual([]);
    expect(redactPrivate('I can go up to $1200', m, [1125]).removed).toContain('price_limit');
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
