import { describe, it, expect, vi, beforeEach } from 'vitest';
import { actions, allowedChannels, allowedTools, canPlaceCall, deals, events, jobs, mandates, openDb, type Mandate } from '@proxydeal/core';
import { McpFoAdapter, renderRequest, type FoConnection, type FoInbound } from '@proxydeal/fo';
import { mandateProblems } from '../packages/llm/src/scenario.js';
import { Store } from '../apps/proxy/src/store.js';
import type { Config } from '../apps/proxy/src/config.js';

// recordCall reads offers out of the counterparty's lines with a model call; stub it.
vi.mock('../apps/proxy/src/inbound.js', () => ({
  extract: vi.fn(async (text: string) => ({ offerAmount: /five thirty|\$530/i.test(text) ? 530 : null, accepts: /works/i.test(text), optOut: false })),
}));
const { matchCall, callSettled, outboundCopy, recordCall } = await import('../apps/proxy/src/calls.js');
const { liveCallRules, requirePeerReady } = await import('../apps/proxy/src/handlers.js');

const silent = { info() {}, warn() {}, error() {} } as never;
const mandate: Mandate = {
  floorOrCeiling: 450, openingOffer: 750, maxConcessionPerRound: 75, walkAwayAt: 6,
  dealbreakers: [], allowedShare: [], neverShare: ['floor'], secrets: {},
};

function cfgFor(owner: string, counterparty: string, peerUrl?: string): Config {
  return {
    proxyId: owner, role: owner === 'Ryan' ? 'seller' : 'buyer', owner, counterparty: { name: counterparty, phone: '+16283095698' },
    foMcpUrl: '', foOauthPort: 0, port: 0, dbPath: ':memory:', mockFo: true, workerIntervalMs: 1000, timeScale: 1, peerUrl,
  };
}

function storeWithDeal() {
  const db = openDb(':memory:');
  db.insert(deals).values({ id: 'PD-TEST01', role: 'seller', item: 'sofa', stage: 'NEGOTIATING', status: 'active', counterparty: { name: 'Muhammed', kind: 'fo' }, createdAt: '2026-10-17T19:00:00Z' }).run();
  db.insert(mandates).values({ dealId: 'PD-TEST01', data: mandate }).run();
  return new Store(db, silent);
}

// Shape of the real 21:19Z call in Ryan's Fo: "assistant" is Ryan's Fo, "user" is whoever answered.
const realCall: FoInbound = {
  conversationId: 'conv-voice-1', channel: 'voice', title: 'Pickup Deal PD-TEST 01', startedAt: '2026-10-17T21:19:24Z',
  turns: [
    { role: 'assistant', text: "Hi, this is Ryan's AI assistant, re: deal PD-TEST zero one. Yes to five thirty.", at: '2026-10-17T21:20:07Z' },
    { role: 'user', text: 'Five thirty works, and pickup before next Sunday is fine.', at: '2026-10-17T21:20:15Z' },
    { role: 'assistant', text: 'Great, thanks again. Goodbye.', at: '2026-10-17T21:20:34Z' },
  ],
};

describe('which voice conversations are deal calls', () => {
  let store: Store;
  beforeEach(() => { store = storeWithDeal(); });

  it('matches the deal id even when Fo spaces it out in the title', () => {
    expect(matchCall(store, ['PD-TEST01'], realCall)).toBe('PD-TEST01');
  });
  it('matches an untitled call by a call action we dispatched shortly before', () => {
    store.db.insert(actions).values({ dealId: 'PD-TEST01', stage: 'NEGOTIATING', channel: 'call', target: '+16283095698', objective: 'Offer', startedAt: '2026-10-17T21:15:00Z' }).run();
    const untitled = { ...realCall, title: 'Call', turns: [{ role: 'user', text: 'Hello?', at: '2026-10-17T21:20:00Z' }] };
    expect(matchCall(store, ['PD-TEST01'], untitled)).toBe('PD-TEST01');
  });
  it("ignores the owner's own voice chat with their Fo", () => {
    const ownChat = { ...realCall, title: 'Brief Greeting Exchange', turns: [{ role: 'assistant', text: 'Hey Muhammad!', at: '2026-10-17T20:13:37Z' }, { role: 'user', text: 'Justing', at: '2026-10-17T20:13:42Z' }] };
    expect(matchCall(store, ['PD-TEST01'], ownChat)).toBeUndefined();
  });
  it('waits until nobody has spoken for a minute', () => {
    const last = Date.parse('2026-10-17T21:20:34Z');
    expect(callSettled(realCall, last + 30_000)).toBe(false);
    expect(callSettled(realCall, last + 61_000)).toBe(true);
  });
});

describe('both agents get the call transcript', () => {
  it('caller records it, sends a copy, and only uses the other side\'s words as their evidence', async () => {
    const store = storeWithDeal();
    const cfg = cfgFor('Ryan', 'Muhammed', 'http://localhost:4002');
    const copy = outboundCopy(store, cfg, 'PD-TEST01', realCall);
    expect(copy.turns.map((t) => t.side)).toEqual(['caller', 'callee', 'caller']);
    await recordCall(store, cfg, copy, 'outbound');
    const kinds = store.db.select().from(events).all().map((e) => e.kind);
    expect(kinds).toContain('CallTranscript');
    const inbound = store.db.select().from(events).all().find((e) => e.kind === 'InboundMessage')!;
    expect((inbound.data as { text: string }).text).toBe('Five thirty works, and pickup before next Sunday is fine.');
    expect(store.lastOffer('PD-TEST01', 'counterparty')?.amount).toBe(530);
    const types = store.db.select().from(jobs).all().map((j) => j.type).sort();
    expect(types).toEqual(['share_call', 'turn']);
  });

  it('receiver records the copy as an inbound call and does not send it back', async () => {
    const store = storeWithDeal();
    const cfg = cfgFor('Muhammed', 'Ryan', 'http://localhost:4001');
    const copy = outboundCopy(store, cfgFor('Ryan', 'Muhammed'), 'PD-TEST01', realCall);
    await recordCall(store, cfg, copy, 'inbound');
    const t = store.db.select().from(events).all().find((e) => e.kind === 'CallTranscript')!;
    expect((t.data as { direction: string }).direction).toBe('inbound');
    // For the receiver the other side is the caller, so Ryan's Fo lines are the counterparty's words.
    const inbound = store.db.select().from(events).all().find((e) => e.kind === 'InboundMessage')!;
    expect((inbound.data as { text: string }).text).toContain('Yes to five thirty');
    expect(store.db.select().from(jobs).all().map((j) => j.type)).toEqual(['turn']);
  });

  it('is recorded once even if the copy arrives twice', async () => {
    const store = storeWithDeal();
    const cfg = cfgFor('Muhammed', 'Ryan');
    const copy = outboundCopy(store, cfgFor('Ryan', 'Muhammed'), 'PD-TEST01', realCall);
    expect((await recordCall(store, cfg, copy, 'inbound')).recorded).toBe(true);
    expect((await recordCall(store, cfg, copy, 'inbound')).recorded).toBe(false);
    expect(store.db.select().from(events).all().filter((e) => e.kind === 'CallTranscript')).toHaveLength(1);
  });
});

describe('Fo replies', () => {
  it('reads conversations from structuredContent, not the human-readable text', async () => {
    const fo = {
      callTool: async (name: string) => name === 'list_fo_conversations'
        ? { content: [{ type: 'text', text: 'Pickup Deal (voice, 2026-10-17T21:19:24Z) – conv-voice-1' }], structuredContent: { conversations: [{ conversationId: 'conv-voice-1', title: 'Pickup Deal', channel: 'voice', startedAt: '2026-10-17T21:19:24Z' }] } }
        : { content: [{ type: 'text', text: 'transcript' }], structuredContent: { turns: [{ role: 'user', text: 'hi', at: '2026-10-17T21:19:30Z' }] } },
    } as unknown as FoConnection;
    const caps = { threads: { toolName: 'list_fo_conversations' }, thread_read: { toolName: 'get_fo_conversation' } } as never;
    const out = await new McpFoAdapter(fo, caps).inbound('2026-10-17T19:00:00Z', new Set());
    expect(out).toEqual([{ conversationId: 'conv-voice-1', channel: 'voice', title: 'Pickup Deal', startedAt: '2026-10-17T21:19:24Z', turns: [{ role: 'user', text: 'hi', at: '2026-10-17T21:19:30Z' }] }]);
  });
});

describe('owner choices', () => {
  it('agents can brief their own Fo while negotiating (and in every open stage)', () => {
    for (const s of ['NEGOTIATING', 'AGREED', 'LOGISTICS'] as const) expect(allowedTools(s)).toContain('brief_fo');
    expect(allowedTools('CLOSED')).toEqual([]);
  });
  it('only the buyer places calls', () => {
    expect(canPlaceCall('buyer')).toBe(true);
    expect(canPlaceCall('seller')).toBe(false);
  });
  it('channel setting limits outbound channels; email is never used', () => {
    expect(allowedChannels('call')).toEqual(['call']);
    expect(allowedChannels('text')).toEqual(['text']);
    expect(allowedChannels('auto')).toEqual(['text', 'call']);
  });
  it("rejects a scenario side that opens past its own limit", () => {
    expect(mandateProblems('seller', { ...mandate, openingOffer: 400 })).toHaveLength(1);
    expect(mandateProblems('buyer', { ...mandate, floorOrCeiling: 600, openingOffer: 650 })).toHaveLength(1);
    expect(mandateProblems('buyer', { ...mandate, floorOrCeiling: 600, openingOffer: 380 })).toEqual([]);
  });
});

describe('calls settle live', () => {
  it('gives Fo the true limit and the current price, and forbids deferring', () => {
    const store = storeWithDeal();
    store.addOffer('PD-TEST01', 'self', 600, '', '');
    const rules = liveCallRules({ store, cfg: cfgFor('Ryan', 'Muhammed'), dealId: 'PD-TEST01', fo: {} as never }, mandate).join('\n');
    expect(rules).toContain('Your current price is $600');
    expect(rules).toContain('any price at or above $450');
    expect(rules).toMatch(/binding agreement/);
    expect(rules).toMatch(/counter-offer that moves down toward them by at most \$75/);
    expect(rules).toMatch(/cannot negotiate or can only take a message/);
    expect(rules).toMatch(/Do not say you will pass the offer along.*schedule another call/);
    expect(rules).not.toMatch(/confirm in writing/);
  });
});

describe('the other Fo is briefed before we dial', () => {
  const ctx = () => ({ store: storeWithDeal(), cfg: cfgFor('Ryan', 'Muhammed', 'http://peer'), dealId: 'PD-TEST01', fo: {} as never });
  it('blocks the call until the peer proxy says its Fo is briefed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ briefed: false }))));
    await expect(requirePeerReady(ctx())).rejects.toThrow(/being briefed now/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ briefed: true }))));
    await expect(requirePeerReady(ctx())).resolves.toBeUndefined();
  });
  it('treats an unreachable peer as not ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(requirePeerReady(ctx())).rejects.toThrow(/do not call yet/);
    vi.unstubAllGlobals();
  });
});

describe('call requests to Fo', () => {
  it('drop the text-only "nothing beyond what is written" rules that stop Fo negotiating', () => {
    const base = { to: '+16283095698', objective: 'Open at $1300', dealId: 'PD-TEST01', script: "Hi, this is Ryan's AI assistant; this call may be recorded.", constraints: ['You may agree to any price at or above $950.'], mustDisclose: true as const };
    const call = renderRequest({ ...base, channel: 'call' });
    expect(call).toContain('negotiate live to a conclusion');
    expect(call).not.toContain('Do not make commitments');
    expect(renderRequest({ ...base, channel: 'text' })).toContain('Do not make commitments');
  });
});
