import { approvals, events, now, type Channel } from '@proxydeal/core';
import { and, eq, sql } from 'drizzle-orm';
import type { FoAdapter } from '@proxydeal/fo';
import type { Config } from './config.js';
import { BRIEF_VERSION, autoConfirm, briefFo, completeAction } from './handlers.js';
import { runTurn, prewarm } from './orchestrator.js';
import { pollInbound } from './inbound.js';
import { shareCall, type CallCopy } from './calls.js';
import { hashPayload, type Store } from './store.js';

const MAX_FO_POLLS = 80; // ~20 minutes at 15s
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

  /** One pending poll at a time: a "check now" request adds an immediate poll, which must not fork a second loop. */
  private ensureNextPoll() {
    const pending = this.store.db.$client.prepare("SELECT 1 FROM jobs WHERE type='inbound_poll' AND status='pending'").get();
    if (!pending) this.store.enqueue('inbound_poll', {}, { inMs: this.cfg.inboundPollMs });
  }

  /** Check Fo for new texts right now (dashboard button, or the check script). */
  checkNow() {
    this.ensureNextPoll();
    this.store.db.$client.prepare("UPDATE jobs SET run_at=? WHERE type='inbound_poll' AND status='pending'").run(new Date().toISOString());
    this.kick();
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
            // A failed turn leaves the deal with nothing scheduled, so it would stall for good (e.g. after a network
            // drop). Try the same trigger again later, backing off, a few times.
            const p = job.payload as { triggerId?: string; reason?: string; revived?: number };
            const revived = p.revived ?? 0;
            if (job.type === 'turn' && job.dealId && revived < 4) {
              const inMs = 2 * 60_000 * 2 ** revived;
              this.store.enqueue('turn', { ...p, triggerId: `${p.triggerId}:retry${revived + 1}`, revived: revived + 1 }, { dealId: job.dealId, inMs });
              this.store.event(job.dealId, 'FollowupScheduled', 'system', { runAt: new Date(Date.now() + inMs).toISOString(), reason: 'Retrying a turn that failed (network or API error)', tactic: 'retry' });
            }
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
        finally { this.ensureNextPoll(); }
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
        let st = await this.fo.status(p.foTaskId);
        // Fo can start working and only then stop for its owner's go-ahead: same rules as at send time.
        if (st.state !== 'working' && !p.checkedHold) {
          const sent = this.store.db.select().from(events).where(and(eq(events.dealId, dealId!), eq(events.kind, 'FoAction'),
            sql`json_extract(${events.data}, '$.foConversationId') = ${p.foTaskId}`)).get()?.data as { script?: string; channel?: Channel; commits?: boolean } | undefined;
          if (sent?.script && sent.channel) {
            const next = await autoConfirm({ store: this.store, fo: this.fo, cfg: this.cfg, dealId: dealId! }, p.foTaskId, st, sent.script, sent.channel, sent.commits !== false);
            if (next !== st && next.state === 'working') {
              this.store.enqueue('fo_poll', { ...p, checkedHold: true, polls: p.polls + 1 }, { dealId: dealId!, inMs: 15_000 });
              return;
            }
            st = next;
          }
        }
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
        // Money moves only here, only for an approved tier-3 row whose hash matches the exact payload,
        // and only when the operator turned payments on (they are off for the demo).
        if (!this.cfg.allowPayments) {
          this.store.event(dealId!, 'GuardBlocked', 'system', { guard: 'spend_cap', reason: 'Payments are disabled (ALLOW_PAYMENTS is not 1); Fo never moves money' });
          this.store.enqueue('turn', { triggerId: `paid:${p.approvalId}`, reason: 'Payment was NOT sent: payments are disabled for this demo. Payment happens in person at pickup; do not try again.' }, { dealId: dealId! });
          return;
        }
        const a =this.store.db.select().from(approvals).where(eq(approvals.id, p.approvalId)).get();
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
