import { createHash } from 'node:crypto';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  approvals, commitments, deals, events, jobs, mandates, offers, processed, verifications, dnc, now,
  type Actor, type DB, type Mandate, type Stage, type DealStatus,
} from '@proxydeal/core';

export type JobType = 'turn' | 'fo_poll' | 'inbound_poll' | 'pay_execute' | 'cache_warm';

/** Canonical JSON (sorted keys) so equal payloads hash equally. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const hashPayload = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

export class Store {
  constructor(readonly db: DB, readonly log: Logger) {}

  event(dealId: string, kind: string, actor: Actor, data: Record<string, unknown>) {
    const row = this.db.insert(events).values({ dealId, ts: now(), kind, actor, data }).returning().get();
    this.log.info({ dealId, kind, actor, ...data }, kind);
    return row;
  }

  deal(id: string) { return this.db.select().from(deals).where(eq(deals.id, id)).get(); }
  activeDeals() { return this.db.select().from(deals).where(eq(deals.status, 'active')).all(); }
  openDeals() { return this.db.select().from(deals).where(sql`${deals.status} in ('active','paused')`).all(); }
  mandate(id: string): Mandate {
    const m = this.db.select().from(mandates).where(eq(mandates.dealId, id)).get();
    if (!m) throw new Error(`No mandate for ${id}`);
    return m.data;
  }
  setStage(id: string, stage: Stage) { this.db.update(deals).set({ stage }).where(eq(deals.id, id)).run(); }
  setStatus(id: string, status: DealStatus) { this.db.update(deals).set({ status }).where(eq(deals.id, id)).run(); }

  offers(id: string) { return this.db.select().from(offers).where(eq(offers.dealId, id)).orderBy(asc(offers.id)).all(); }
  lastOffer(id: string, from: 'self' | 'counterparty') {
    return this.db.select().from(offers).where(and(eq(offers.dealId, id), eq(offers.from, from))).orderBy(desc(offers.id)).get();
  }
  addOffer(dealId: string, from: 'self' | 'counterparty', amount: number, terms: string, rationale: string) {
    return this.db.insert(offers).values({ dealId, from, amount, terms, rationale, ts: now() }).returning().get();
  }

  openCommitments(id: string) {
    return this.db.select().from(commitments).where(and(eq(commitments.dealId, id), eq(commitments.status, 'open'))).all();
  }
  recentEvents(id: string, n: number) {
    return this.db.select().from(events).where(eq(events.dealId, id)).orderBy(desc(events.id)).limit(n).all().reverse();
  }
  lastVerification(dealId: string, stage: string) {
    return this.db.select().from(verifications).where(and(eq(verifications.dealId, dealId), eq(verifications.stage, stage))).orderBy(desc(verifications.id)).get();
  }
  pendingApproval(dealId: string) {
    return this.db.select().from(approvals).where(and(eq(approvals.dealId, dealId), eq(approvals.status, 'pending'))).get();
  }
  approvedWithHash(dealId: string, tier: number, hash: string) {
    return this.db.select().from(approvals).where(and(eq(approvals.dealId, dealId), eq(approvals.tier, tier), eq(approvals.status, 'approved'), eq(approvals.payloadHash, hash))).get();
  }
  isDnc(target: string) { return Boolean(this.db.select().from(dnc).where(eq(dnc.target, target)).get()); }
  addDnc(target: string, reason: string) { this.db.insert(dnc).values({ target, reason, ts: now() }).onConflictDoNothing().run(); }

  isProcessed(id: string) { return Boolean(this.db.select().from(processed).where(eq(processed.id, id)).get()); }
  markProcessed(id: string) { this.db.insert(processed).values({ id, ts: now() }).onConflictDoNothing().run(); }

  enqueue(type: JobType, payload: Record<string, unknown>, opts: { dealId?: string; inMs?: number } = {}) {
    const runAt = new Date(Date.now() + (opts.inMs ?? 0)).toISOString();
    return this.db.insert(jobs).values({ dealId: opts.dealId ?? null, type, payload, runAt }).returning().get();
  }
  cancelPending(dealId: string, type: JobType, where?: (p: Record<string, unknown>) => boolean) {
    const rows = this.db.select().from(jobs).where(and(eq(jobs.dealId, dealId), eq(jobs.type, type), eq(jobs.status, 'pending'))).all();
    for (const r of rows) if (!where || where(r.payload as Record<string, unknown>))
      this.db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, r.id)).run();
  }
  hasPending(dealId: string, type: JobType) {
    return Boolean(this.db.select().from(jobs).where(and(eq(jobs.dealId, dealId), eq(jobs.type, type), eq(jobs.status, 'pending'))).get());
  }
  /** Atomically claim the next due job (single in-process worker, but safe across restarts). */
  claimDue() {
    const t = now();
    const next = this.db.select().from(jobs).where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, t))).orderBy(asc(jobs.runAt)).limit(1).get();
    if (!next) return undefined;
    const res = this.db.update(jobs).set({ status: 'running', lockedAt: t, attempts: next.attempts + 1 })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, 'pending'))).run();
    return res.changes ? { ...next, attempts: next.attempts + 1 } : undefined;
  }
  finishJob(id: number, status: 'done' | 'failed') { this.db.update(jobs).set({ status }).where(eq(jobs.id, id)).run(); }
  retryJob(id: number, inMs: number) {
    this.db.update(jobs).set({ status: 'pending', runAt: new Date(Date.now() + inMs).toISOString() }).where(eq(jobs.id, id)).run();
  }
  /** On boot: anything left "running" by a killed process goes back to pending. */
  recoverJobs() { return this.db.update(jobs).set({ status: 'pending' }).where(eq(jobs.status, 'running')).run().changes; }
}
