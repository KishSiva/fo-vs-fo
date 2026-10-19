import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, readFileSync } from 'node:fs';
import { and, asc, eq, gte, desc } from 'drizzle-orm';
import { approvals, commitments, deals, events, offers, verifications, foCapabilities, redactMandate, now, CHANNEL_PREFS, STRATEGIES, mandates, type ChannelPref, type Mandate, type Strategy } from '@proxydeal/core';
import { cacheStats, cacheTtl, parseScenario, parseListing, mandateProblems, generatePlan, planProblems, planText, type DealPlan } from '@proxydeal/llm';
import type { FoAdapter, MockFoAdapter } from '@proxydeal/fo';
import { confirmText } from './handlers.js';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { Worker } from './worker.js';
import { recordCall, type CallCopy } from './calls.js';

export async function startApi(store: Store, cfg: Config, worker: Worker, foSignedIn: () => boolean, fo: FoAdapter, mockFo?: MockFoAdapter) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/], methods: ['GET', 'POST'] });
  const db = store.db;

  app.get('/api/health', async () => ({
    proxyId: cfg.proxyId, owner: cfg.owner, role: cfg.role,
    capabilities: Object.fromEntries(db.select().from(foCapabilities).all().map((c) => {
      const s = c.schema as { viaAgent?: boolean } | null;
      return [c.key, { toolName: c.toolName, viaAgent: Boolean(s?.viaAgent) }];
    })),
    worker: { lastBeat: worker.lastBeat },
    foSignedIn: foSignedIn(),
    mockFo: cfg.mockFo,
    ownerPhone: cfg.ownerNotifyPhone ?? null,
    foPhone: cfg.ownerPhone ?? null,
    paymentsEnabled: cfg.allowPayments,
    promptCache: { prefixTtl: cacheTtl(), routes: cacheStats() },
  }));

  app.get('/api/deals', async () => db.select().from(deals).orderBy(desc(deals.createdAt)).all());

  app.get<{ Params: { id: string } }>('/api/deals/:id', async (req, reply) => {
    const d = store.deal(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not found' });
    return { ...d, mandate: redactMandate(store.mandate(d.id)) };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/deals/:id/events', async (req) => {
    const where = req.query.after
      ? and(eq(events.dealId, req.params.id), gte(events.ts, req.query.after))
      : eq(events.dealId, req.params.id);
    return db.select().from(events).where(where).orderBy(asc(events.id)).all().map(redactEvent);
  });

  app.get<{ Params: { id: string } }>('/api/deals/:id/offers', async (req) =>
    db.select().from(offers).where(eq(offers.dealId, req.params.id)).orderBy(asc(offers.id)).all());
  app.get<{ Params: { id: string } }>('/api/deals/:id/commitments', async (req) =>
    db.select().from(commitments).where(eq(commitments.dealId, req.params.id)).all());
  app.get<{ Params: { id: string } }>('/api/deals/:id/verifications', async (req) =>
    db.select().from(verifications).where(eq(verifications.dealId, req.params.id)).orderBy(asc(verifications.id)).all());

  app.get<{ Querystring: { status?: string } }>('/api/approvals', async (req) =>
    req.query.status
      ? db.select().from(approvals).where(eq(approvals.status, req.query.status)).all()
      : db.select().from(approvals).all());

  app.post<{ Params: { id: string }; Body: { decision: 'approved' | 'denied' } }>('/api/approvals/:id/decide', async (req, reply) => {
    const id = Number(req.params.id);
    const decision = req.body?.decision;
    if (decision !== 'approved' && decision !== 'denied') return reply.code(400).send({ error: 'decision must be approved|denied' });
    const a = db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!a) return reply.code(404).send({ error: 'not found' });
    if (a.status !== 'pending') return reply.code(409).send({ error: `already ${a.status}` });
    const row = store.decideApproval(id, decision, cfg.owner);
    worker.kick();
    return row;
  });

  /**
   * The owner approves a message Fo is holding for its go-ahead (one that commits to a deal, or any message when
   * auto-approval is off). The answer goes to Fo through the same MCP connection, in Fo's own conversation.
   */
  app.post<{ Params: { id: string }; Body: { foConversationId?: string } }>('/api/deals/:id/fo-confirm', async (req, reply) => {
    const conv = req.body?.foConversationId;
    const held = store.db.select().from(events).where(and(eq(events.dealId, req.params.id), eq(events.kind, 'FoHeld'))).all()
      .find((e) => (e.data as { foConversationId?: string }).foConversationId === conv);
    if (!held) return reply.code(404).send({ error: 'No held Fo message with that id on this deal' });
    const d = held.data as { channel: 'text' | 'call'; canApprove?: boolean };
    if (!d.canApprove) return reply.code(409).send({ error: 'Fo is holding different words than the agent wrote; review it in the Fo app instead' });
    if (store.isProcessed(`fo-confirm:${conv}`)) return reply.code(409).send({ error: 'Already approved' });
    const yes = confirmText({ store, fo, cfg, dealId: req.params.id }, d.channel);
    store.markProcessed(`ourreply:${conv}:${yes}`);
    const st = await fo.reply(conv!, yes);
    store.markProcessed(`fo-confirm:${conv}`);
    store.event(req.params.id, 'FoConfirmed', 'human', { foConversationId: conv, channel: d.channel, foReply: st.summary?.slice(0, 300), by: `${cfg.owner} (dashboard)` });
    store.enqueue('turn', { triggerId: `fo-confirm:${conv}`, reason: `${cfg.owner} approved the message Fo was holding; Fo replied: ${st.summary?.slice(0, 500) ?? st.state}` }, { dealId: req.params.id });
    worker.kick();
    return { ok: true, foState: st.state, foReply: st.summary?.slice(0, 300) };
  });

  /** Plain-language scenario -> item + both sides' mandates, for the owner to review before creating. */
  app.post<{ Body: { text?: string } }>('/api/scenarios/parse', async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'Describe the scenario first' });
    if (text.length > 8000) return reply.code(400).send({ error: 'Keep the scenario under 8,000 characters' });
    const names = cfg.role === 'seller' ? { seller: cfg.owner, buyer: cfg.counterparty.name } : { seller: cfg.counterparty.name, buyer: cfg.owner };
    return { ...(await parseScenario(text, names)), names };
  });

  /** Marketplace mode: pasted listing + the owner's private brief -> item + this side's mandate, for review before creating. */
  /** Research comps and draft a negotiation plan for the owner to review; with previous + feedback, revise it. */
  app.post<{ Body: { listing?: string; notes?: string; previous?: DealPlan; feedback?: string } }>('/api/plans/generate', async (req, reply) => {
    const listing = req.body?.listing?.trim();
    const notes = req.body?.notes?.trim() ?? '';
    if (!listing) return reply.code(400).send({ error: 'Paste the listing first' });
    if (listing.length + notes.length + (req.body?.feedback?.length ?? 0) > 12000) return reply.code(400).send({ error: 'Keep the listing and notes under 12,000 characters' });
    return generatePlan({ role: cfg.role, owner: cfg.owner, listing, notes, previous: req.body?.previous, feedback: req.body?.feedback?.trim() });
  });

  app.post<{ Body: { listing?: string; brief?: string; plan?: DealPlan } }>('/api/listings/parse', async (req, reply) => {
    const listing = req.body?.listing?.trim();
    const plan = req.body?.plan;
    const brief = [req.body?.brief?.trim(), plan && `Owner-approved negotiation plan:\n${planText(plan, cfg.role)}`].filter(Boolean).join('\n\n');
    if (!listing) return reply.code(400).send({ error: 'Paste the listing first' });
    if (listing.length + brief.length > 20000) return reply.code(400).send({ error: 'Keep the listing and brief under 20,000 characters' });
    const parsed = await parseListing(cfg.role, listing, brief);
    if (plan) parsed.mandate = applyPlan(parsed.mandate, plan);
    return { ...parsed, role: cfg.role, owner: cfg.owner, ownerPhone: cfg.ownerNotifyPhone ?? null };
  });

  /** Create this proxy's side of a deal. The dashboard calls every proxy with the same id and that side's mandate. */
  app.post<{ Body: { id?: string; item?: string; mandate?: Mandate; channelPref?: string; start?: boolean; counterparty?: { name?: string; phone?: string }; strategy?: string; plan?: DealPlan; listing?: string; brief?: string } }>('/api/deals', async (req, reply) => {
    const b = req.body ?? {};
    const id = b.id?.trim() ?? '';
    if (!/^PD-[A-Z0-9]{4,}$/.test(id)) return reply.code(400).send({ error: 'id must look like PD-1A2B3C' });
    if (store.deal(id)) return reply.code(409).send({ error: `${id} already exists` });
    if (!b.item?.trim() || !b.mandate) return reply.code(400).send({ error: 'item and mandate are required' });
    // A pasted contact means a real person on the other end (marketplace mode): text by default, calls if the owner picks them.
    // Stored digits-only so Fo, inbound matching and the rehearsal phones all use one format.
    const human = b.counterparty?.phone?.replace(/[\s().-]/g, '');
    if (human && !/^\+?[\d\s().-]{10,}$/.test(human)) return reply.code(400).send({ error: 'counterparty phone must be a phone number, e.g. +1 415 555 0100' });
    const channelPref = (b.channelPref ?? (human ? 'text' : 'auto')) as ChannelPref;
    const strategy = (b.strategy ?? 'coach') as Strategy;
    if (!STRATEGIES.includes(strategy)) return reply.code(400).send({ error: `strategy must be ${STRATEGIES.join('|')}` });
    if (!CHANNEL_PREFS.includes(channelPref)) return reply.code(400).send({ error: `channelPref must be ${CHANNEL_PREFS.join('|')}` });
    if (b.plan) {
      const bad = planProblems(cfg.role, b.plan);
      if (bad.length) return reply.code(400).send({ error: `Fix the plan first: ${bad.join(' ')}` });
    }
    // The approved plan's prices are authoritative, whatever the parsed mandate says.
    const m = b.plan ? applyPlan(b.mandate, b.plan) : b.mandate;
    const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (!strs(m.dealbreakers) || !strs(m.allowedShare) || !strs(m.neverShare) || typeof m.secrets !== 'object' || !Number.isInteger(m.walkAwayAt))
      return reply.code(400).send({ error: 'mandate is malformed' });
    // Only this side's mandate comes here, so only this side's rules can be checked.
    const problems = mandateProblems(cfg.role, m);
    if (problems.length) return reply.code(400).send({ error: problems.join(' ') });

    const counterparty = human
      ? { name: b.counterparty?.name?.trim() || (cfg.role === 'buyer' ? 'the seller' : 'the buyer'), kind: 'human' as const, phone: human }
      : { name: cfg.counterparty.name, kind: 'fo' as const, phone: cfg.counterparty.phone, email: cfg.counterparty.email };
    db.insert(deals).values({
      id, role: cfg.role, item: b.item.trim(), stage: 'NEGOTIATING', status: 'active', channelPref, strategy, createdAt: now(), counterparty,
    }).run();
    db.insert(mandates).values({ dealId: id, data: m }).run();
    // The owner's raw listing and notes are kept with the deal so a run can be replayed exactly.
    store.event(id, 'DealCreated', 'human', {
      item: b.item.trim(), channelPref, from: 'dashboard', marketplace: Boolean(human), counterparty: counterparty.name, strategy,
      ...(b.plan ? { plan: b.plan } : {}), ...(b.listing ? { listing: b.listing } : {}), ...(b.brief ? { brief: b.brief } : {}),
    });
    // Brief our Fo before anything else, so it can negotiate if the other side calls first.
    store.enqueue('brief', {}, { dealId: id });
    if (b.start !== false) {
      const reason = human
        ? cfg.role === 'buyer'
          ? strategy === 'handoff' && channelPref !== 'call'
            ? `Deal created in HAND-OFF mode. ${counterparty.name} listed this on Facebook Marketplace: ${b.item.trim()}. ${b.plan ? 'Give Fo the owner-approved plan now with handoff_plan' : 'Build your complete negotiation strategy now and give it to Fo with handoff_plan'} (Fo sends your opener). Payment is in person only; nothing is paid through Fo.`
            : `Deal created. ${counterparty.name} listed this on Facebook Marketplace: ${b.item.trim()}. ${channelPref === 'call' ? 'Call them about the listing' : 'Text them first about the listing, Marketplace style,'} and start discovering their interests${b.plan ? ', following the owner-approved plan (use its opener)' : ''}. Payment is in person only; nothing is paid through Fo.`
          : `Deal created. You listed this on Facebook Marketplace: ${b.item.trim()}. ${counterparty.name} is interested; ${channelPref === 'call' ? 'they will call you, or' : ''} text them to start. Payment is in person only.`
        : cfg.role === 'seller'
        ? `Deal created. You are selling: ${b.item.trim()}. ${cfg.counterparty.name} (the buyer) will call you; you never place calls. Your Fo is being briefed to negotiate and close live when it answers. Do not contact them now; schedule a follow-up and act on the call transcript when it arrives.`
        : `Deal created. You are buying: ${b.item.trim()}. Call ${cfg.counterparty.name} (the seller) now with your opening offer and negotiate to a deal on that call. Only you place calls; the seller never calls you.`;
      store.enqueue('turn', { triggerId: 'kickoff', reason }, { dealId: id, inMs: 1000 });
      worker.kick();
    } else store.setStatus(id, 'paused');
    return store.deal(id);
  });

  /** Asked by the other proxy before its Fo dials ours: is our Fo briefed to negotiate live? Briefs now if not. */
  app.get<{ Params: { id: string } }>('/api/deals/:id/readiness', async (req, reply) => {
    const d = store.deal(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not found' });
    if (d.status !== 'active') return { briefed: false, reason: `deal is ${d.status}` };
    return { briefed: worker.ensureBriefed(d.id) };
  });

  /** The other proxy's copy of a call its Fo placed to ours (our Fo keeps no record of answering). */
  app.post<{ Params: { id: string }; Body: CallCopy }>('/api/deals/:id/calls', async (req, reply) => {
    const call = req.body;
    if (!store.deal(req.params.id)) return reply.code(404).send({ error: 'not found' });
    if (!call?.conversationId || !Array.isArray(call.turns) || call.dealId !== req.params.id)
      return reply.code(400).send({ error: 'expected a call copy for this deal' });
    if (call.callee !== cfg.owner || call.caller !== cfg.counterparty.name)
      return reply.code(400).send({ error: `call is between ${call.caller} and ${call.callee}, not ${cfg.counterparty.name} and ${cfg.owner}` });
    const turns = call.turns.filter((t) => (t.side === 'caller' || t.side === 'callee') && typeof t.text === 'string');
    const res = await recordCall(store, cfg, { ...call, turns }, 'inbound');
    worker.kick();
    return res;
  });

  app.post<{ Params: { id: string }; Body: { type: string; channel?: string } }>('/api/deals/:id/command', async (req, reply) => {
    const d = store.deal(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not found' });
    const type = req.body?.type;
    if (type === 'channel') {
      const channel = req.body?.channel as ChannelPref;
      if (!CHANNEL_PREFS.includes(channel)) return reply.code(400).send({ error: `channel must be ${CHANNEL_PREFS.join('|')}` });
      store.setChannelPref(d.id, channel);
      store.event(d.id, 'Command', 'human', { type, channel });
      return { ok: true };
    }
    store.event(d.id, 'Command', 'human', { type });
    if (type === 'pause') { store.setStatus(d.id, 'paused'); store.cancelPending(d.id, 'turn'); }
    else if (type === 'resume') { store.setStatus(d.id, 'active'); worker.ensureBriefed(d.id); store.enqueue('turn', { triggerId: `resume:${Date.now()}`, reason: 'Owner resumed the deal' }, { dealId: d.id }); }
    else if (type === 'check') worker.checkNow();
    else if (type === 'nudge') store.enqueue('turn', { triggerId: `nudge:${Date.now()}`, reason: 'Owner nudged: re-check the deal and act' }, { dealId: d.id });
    else if (type === 'abandon') { store.setStatus(d.id, 'abandoned'); store.setStage(d.id, 'ABANDONED'); store.cancelPending(d.id, 'turn'); store.closeApprovals(d.id, 'deal abandoned'); }
    else return reply.code(400).send({ error: 'type must be check|nudge|pause|resume|abandon|channel' });
    worker.kick();
    return { ok: true };
  });

  /** Rehearsal only (MOCK_FO=1): play the other side or the owner by "texting" this proxy's Fo. */
  if (mockFo) {
    app.post<{ Body: { from?: string; text?: string } }>('/api/mock/text', async (req, reply) => {
      const from = req.body?.from?.trim();
      const text = req.body?.text?.trim();
      if (!from || !text) return reply.code(400).send({ error: 'from and text are required' });
      mockFo.inject(from, mockFo.address, 'sms', text);
      worker.checkNow();
      return { ok: true };
    });
    app.get<{ Querystring: { with?: string } }>('/api/mock/thread', async (req, reply) => {
      if (!req.query.with) return reply.code(400).send({ error: 'with is required' });
      return mockFo.thread(req.query.with);
    });
  }

  app.get('/api/scorecard', async () =>
    existsSync('scorecard.json') ? JSON.parse(readFileSync('scorecard.json', 'utf8')) : { generatedAt: null, rows: [] });

  await app.listen({ port: cfg.port, host: '127.0.0.1' });
  return app;
}

/** Private reasoning stays in the DB; the dashboard sees the action, not the rationale. */
function redactEvent<T extends { data: unknown }>(e: T): T {
  const d = e.data as Record<string, unknown>;
  if (d && typeof d === 'object' && 'rationale' in d) {
    const { rationale: _r, ...rest } = d;
    return { ...e, data: rest };
  }
  return e;
}

/** The approved plan sets the opening, the hard limit and room for its ladder's biggest step. */
function applyPlan(m: Mandate, p: DealPlan): Mandate {
  const steps = p.ladder.map((st, n) => Math.abs(st.amount - (n === 0 ? p.prices.open : p.ladder[n - 1].amount)));
  const dealbreakers = [...m.dealbreakers, ...p.dealbreakers.filter((d) => !m.dealbreakers.includes(d))];
  return { ...m, openingOffer: p.prices.open, floorOrCeiling: p.prices.limit, maxConcessionPerRound: Math.max(m.maxConcessionPerRound, ...steps), dealbreakers };
}
