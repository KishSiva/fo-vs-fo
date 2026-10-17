import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, readFileSync } from 'node:fs';
import { and, asc, eq, gte, desc } from 'drizzle-orm';
import { approvals, commitments, deals, events, offers, verifications, foCapabilities, redactMandate, now, CHANNEL_PREFS, mandates, type ChannelPref, type Mandate } from '@proxydeal/core';
import { cacheStats, cacheTtl, parseScenario, mandateProblems } from '@proxydeal/llm';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { Worker } from './worker.js';
import { recordCall, type CallCopy } from './calls.js';

export async function startApi(store: Store, cfg: Config, worker: Worker, foSignedIn: () => boolean) {
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
    const row = db.update(approvals).set({ status: decision, decidedAt: now(), decidedBy: cfg.owner }).where(eq(approvals.id, id)).returning().get();
    store.event(a.dealId, 'ApprovalDecided', 'human', { approvalId: id, decision, tier: a.tier });
    store.setStatus(a.dealId, 'active');
    if (decision === 'approved' && a.tier === 3) store.enqueue('pay_execute', { approvalId: id }, { dealId: a.dealId });
    store.enqueue('turn', { triggerId: `approval:${id}`, reason: `Owner ${decision} tier-${a.tier} approval #${id}: ${a.summary}` }, { dealId: a.dealId });
    worker.kick();
    return row;
  });

  /** Plain-language scenario -> item + both sides' mandates, for the owner to review before creating. */
  app.post<{ Body: { text?: string } }>('/api/scenarios/parse', async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'Describe the scenario first' });
    if (text.length > 8000) return reply.code(400).send({ error: 'Keep the scenario under 8,000 characters' });
    const names = cfg.role === 'seller' ? { seller: cfg.owner, buyer: cfg.counterparty.name } : { seller: cfg.counterparty.name, buyer: cfg.owner };
    return { ...(await parseScenario(text, names)), names };
  });

  /** Create this proxy's side of a deal. The dashboard calls every proxy with the same id and that side's mandate. */
  app.post<{ Body: { id?: string; item?: string; mandate?: Mandate; channelPref?: string; start?: boolean } }>('/api/deals', async (req, reply) => {
    const b = req.body ?? {};
    const id = b.id?.trim() ?? '';
    if (!/^PD-[A-Z0-9]{4,}$/.test(id)) return reply.code(400).send({ error: 'id must look like PD-1A2B3C' });
    if (store.deal(id)) return reply.code(409).send({ error: `${id} already exists` });
    if (!b.item?.trim() || !b.mandate) return reply.code(400).send({ error: 'item and mandate are required' });
    const channelPref = (b.channelPref ?? 'auto') as ChannelPref;
    if (!CHANNEL_PREFS.includes(channelPref)) return reply.code(400).send({ error: `channelPref must be ${CHANNEL_PREFS.join('|')}` });
    const m = b.mandate;
    const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (!strs(m.dealbreakers) || !strs(m.allowedShare) || !strs(m.neverShare) || typeof m.secrets !== 'object' || !Number.isInteger(m.walkAwayAt))
      return reply.code(400).send({ error: 'mandate is malformed' });
    // Only this side's mandate comes here, so only this side's rules can be checked.
    const problems = mandateProblems(cfg.role, m);
    if (problems.length) return reply.code(400).send({ error: problems.join(' ') });

    db.insert(deals).values({
      id, role: cfg.role, item: b.item.trim(), stage: 'NEGOTIATING', status: 'active', channelPref, createdAt: now(),
      counterparty: { name: cfg.counterparty.name, kind: 'fo', phone: cfg.counterparty.phone, email: cfg.counterparty.email },
    }).run();
    db.insert(mandates).values({ dealId: id, data: m }).run();
    store.event(id, 'DealCreated', 'human', { item: b.item.trim(), channelPref, from: 'dashboard' });
    // Brief our Fo before anything else, so it can negotiate if the other side calls first.
    store.enqueue('brief', {}, { dealId: id });
    if (b.start !== false) {
      const reason = cfg.role === 'seller'
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
    else if (type === 'resume') { store.setStatus(d.id, 'active'); store.enqueue('turn', { triggerId: `resume:${Date.now()}`, reason: 'Owner resumed the deal' }, { dealId: d.id }); }
    else if (type === 'nudge') store.enqueue('turn', { triggerId: `nudge:${Date.now()}`, reason: 'Owner nudged: re-check the deal and act' }, { dealId: d.id });
    else if (type === 'abandon') { store.setStatus(d.id, 'abandoned'); store.setStage(d.id, 'ABANDONED'); store.cancelPending(d.id, 'turn'); }
    else return reply.code(400).send({ error: 'type must be nudge|pause|resume|abandon|channel' });
    worker.kick();
    return { ok: true };
  });

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
