import Fastify from 'fastify';
import cors from '@fastify/cors';
import { existsSync, readFileSync } from 'node:fs';
import { and, asc, eq, gte, desc } from 'drizzle-orm';
import { approvals, commitments, deals, events, offers, verifications, foCapabilities, redactMandate, now } from '@proxydeal/core';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { Worker } from './worker.js';

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

  app.post<{ Params: { id: string }; Body: { type: string } }>('/api/deals/:id/command', async (req, reply) => {
    const d = store.deal(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not found' });
    const type = req.body?.type;
    store.event(d.id, 'Command', 'human', { type });
    if (type === 'pause') { store.setStatus(d.id, 'paused'); store.cancelPending(d.id, 'turn'); }
    else if (type === 'resume') { store.setStatus(d.id, 'active'); store.enqueue('turn', { triggerId: `resume:${Date.now()}`, reason: 'Owner resumed the deal' }, { dealId: d.id }); }
    else if (type === 'nudge') store.enqueue('turn', { triggerId: `nudge:${Date.now()}`, reason: 'Owner nudged: re-check the deal and act' }, { dealId: d.id });
    else if (type === 'abandon') { store.setStatus(d.id, 'abandoned'); store.setStage(d.id, 'ABANDONED'); store.cancelPending(d.id, 'turn'); }
    else return reply.code(400).send({ error: 'type must be nudge|pause|resume|abandon' });
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
