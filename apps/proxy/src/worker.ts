import { approvals, now } from '@proxydeal/core';
import { eq } from 'drizzle-orm';
import type { FoAdapter } from '@proxydeal/fo';
import type { Config } from './config.js';
import { BRIEF_VERSION, briefFo, completeAction } from './handlers.js';
import { runTurn, prewarm } from './orchestrator.js';
import { pollInbound } from './inbound.js';
import { shareCall, type CallCopy } from './calls.js';
import { hashPayload, type Store } from './store.js';

const MAX_FO_POLLS = 80; // ~20 minutes at 15s
const INBOUND_EVERY_MS = 30_000;
// Re-warm just under the 1-hour TTL so idle deals don't start their next turn cold.
const REWARM_EVERY_MS = 55 * 60_000;

export class Worker {
  lastBeat: string | null = null;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private store: Store, private fo: FoAdapter, private cfg: Config) {}

  start() {
    const n = this.store.recoverJobs();
    if (n) this.store.log.warn({ recovered: n }, 'requeued jobs left running by a previous process');
    this.ensureInboundPoller();
    this.ensureCacheWarmer();
    for (const d of this.store.activeDeals()) this.ensureBriefed(d.id);
    this.timer = setInterval(() => void this.tick(), this.cfg.workerIntervalMs);
    void this.tick();
  }
  stop() { clearInterval(this.timer); }
  /** Run due jobs now instead of waiting for the next interval. */
  kick() { setImmediate(() => void this.tick()); }

  /** Exactly one inbound poller: it reschedules itself, so any extra copy would poll forever too. */
  private ensureInboundPoller() {
    this.store.db.$client.prepare("UPDATE jobs SET status='cancelled' WHERE type='inbound_poll' AND status IN ('pending','running')").run();
    this.store.enqueue('inbound_poll', {});
  }

  /** Queue a briefing for our own Fo unless it already holds the current one (or one is queued). */
  ensureBriefed(dealId: string): boolean {
    if (this.store.briefedAtVersion(dealId, BRIEF_VERSION)) return true;
    const queued = this.store.db.$client.prepare("SELECT 1 FROM jobs WHERE type='brief' AND deal_id=? AND status IN ('pending','running')").get(dealId);
    if (!queued) this.store.enqueue('brief', {}, { dealId });
    this.kick();
    return false;
  }

  private ensureCacheWarmer() {
    this.store.db.$client.prepare("UPDATE jobs SET status='cancelled' WHERE type='cache_warm' AND status='pending'").run();
    this.store.enqueue('cache_warm', {});
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      this.lastBeat = now();
      for (let job = this.store.claimDue(); job; job = this.store.claimDue()) {
        n++;
        try {
          await this.run(job.type, job.dealId, job.payload as Record<string, any>);
          this.store.finishJob(job.id, 'done');
        } catch (e) {
          this.store.log.error({ err: e, job: job.id, type: job.type }, 'job failed');
          if (job.attempts < 3) this.store.retryJob(job.id, 30_000 * job.attempts);
          else {
            this.store.finishJob(job.id, 'failed');
            if (job.dealId) this.store.event(job.dealId, 'JobFailed', 'system', { type: job.type, error: String(e) });
          }
        }
        this.lastBeat = now();
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  private async run(type: string, dealId: string | null, p: Record<string, any>) {
    switch (type) {
      case 'turn':
        await runTurn({ store: this.store, fo: this.fo, cfg: this.cfg, dealId: dealId!, }, { id: p.triggerId, reason: p.reason });
        return;
      case 'inbound_poll':
        // Never let this job fail: a retry plus the reschedule below would leave two pollers.
        try { await pollInbound(this.store, this.fo, this.cfg); }
        catch (e) { this.store.log.error({ err: e }, 'inbound poll failed; retrying on the next poll'); }
        finally { this.store.enqueue('inbound_poll', {}, { inMs: INBOUND_EVERY_MS }); }
        return;
      case 'cache_warm':
        try {
          for (const d of this.store.openDeals()) {
            const u = await prewarm({ store: this.store, fo: this.fo, cfg: this.cfg, dealId: d.id });
            this.store.log.info({ dealId: d.id, cacheWrite: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens }, 'prompt cache warmed');
          }
        } finally { this.store.enqueue('cache_warm', {}, { inMs: REWARM_EVERY_MS }); }
        return;
      case 'fo_poll': {
        const st = await this.fo.status(p.foTaskId);
        if (st.state === 'working' && p.polls < MAX_FO_POLLS) {
          this.store.enqueue('fo_poll', { ...p, polls: p.polls + 1 }, { dealId: dealId!, inMs: 15_000 });
          return;
        }
        if (st.state === 'working') st.state = 'failed', st.summary = `Fo still working after ${MAX_FO_POLLS} polls: ${st.progress ?? ''}`;
        completeAction(this.store, dealId!, p.actionId, p.channel ?? 'fo', st, { triggerTurn: true });
        return;
      }
      case 'brief':
        if (!this.store.briefedAtVersion(dealId!, BRIEF_VERSION))
          await briefFo({ store: this.store, fo: this.fo, cfg: this.cfg, dealId: dealId! });
        return;
      case 'share_call':
        await shareCall(this.cfg, p.call as CallCopy);
        this.store.event(dealId!, 'CallShared', 'system', { conversationId: p.call.conversationId, to: this.cfg.counterparty.name });
        return;
      case 'pay_execute': {
        // Money moves only here, only for an approved tier-3 row whose hash matches the exact payload.
        const a = this.store.db.select().from(approvals).where(eq(approvals.id, p.approvalId)).get();
        const payload = a?.payload as { to: string; amount: number; memo: string } | undefined;
        if (!a || a.tier !== 3 || a.status !== 'approved' || !payload || a.payloadHash !== hashPayload(payload)) {
          this.store.event(dealId!, 'GuardBlocked', 'system', { guard: 'spend_cap', reason: 'Payment refused: no matching approved tier-3 approval' });
          return;
        }
        const m = this.store.mandate(dealId!);
        if (this.cfg.role === 'buyer' && payload.amount > m.floorOrCeiling) {
          this.store.event(dealId!, 'GuardBlocked', 'system', { guard: 'spend_cap', reason: 'Payment exceeds mandate' });
          return;
        }
        const { foTaskId, status } = await this.fo.pay({ ...payload, dealId: dealId! });
        this.store.event(dealId!, 'PaymentRecorded', 'fo', { approvalId: a.id, foTaskId, amount: payload.amount, to: payload.to, summary: status.summary });
        this.store.enqueue('turn', { triggerId: `paid:${a.id}`, reason: `Payment executed via Fo: ${status.summary}` }, { dealId: dealId! });
        return;
      }
    }
  }
}
