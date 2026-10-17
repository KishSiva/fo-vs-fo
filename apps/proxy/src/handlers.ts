import { eq } from 'drizzle-orm';
import {
  actions, approvals, commitments, now, checkOffer, acceptable, nearLimit, canTransition, requiresVerification, STAGES,
  type Channel, type Mandate, type Stage,
} from '@proxydeal/core';
import { guardOutbound } from '@proxydeal/llm';
import { verify } from '@proxydeal/verify';
import type { FoAdapter, FoStatus } from '@proxydeal/fo';
import { hashPayload, type Store } from './store.js';
import type { Config } from './config.js';

export class ToolError extends Error {}

export interface Ctx {
  store: Store;
  fo: FoAdapter;
  cfg: Config;
  dealId: string;
}

type Input = Record<string, any>;

function load(ctx: Ctx) {
  const deal = ctx.store.deal(ctx.dealId);
  if (!deal) throw new ToolError('Deal not found');
  return { deal, mandate: ctx.store.mandate(ctx.dealId), stage: deal.stage as Stage };
}

/** Outbound targets are limited to known parties; anything else needs a human. */
function resolveTarget(ctx: Ctx, channel: Channel, target?: string): string {
  const cp = ctx.cfg.counterparty;
  const known = [cp.phone, cp.email].filter(Boolean) as string[];
  const t = target ?? (channel === 'email' ? cp.email : cp.phone);
  if (!t) throw new ToolError(`No ${channel} address on file for the counterparty`);
  const norm = (s: string) => s.replace(/[\s()-]/g, '').toLowerCase();
  if (!known.some((k) => norm(k) === norm(t))) throw new ToolError(`Unknown target ${t}. Only the counterparty (${known.join(', ')}) may be contacted; escalate_to_human for anyone else.`);
  if (channel === 'email' && !t.includes('@')) throw new ToolError('Email channel needs an email address');
  if (channel !== 'email' && t.includes('@')) throw new ToolError(`${channel} channel needs a phone number`);
  if (ctx.store.isDnc(t)) {
    ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'dnc', reason: `${t} asked not to be contacted` });
    throw new ToolError(`${t} is on the do-not-contact list. Do not contact them; escalate_to_human.`);
  }
  return t;
}

async function guarded(ctx: Ctx, mandate: Mandate, channel: Channel, script: string, offerAmount?: number) {
  const g = await guardOutbound({ channel, script, mandate, role: ctx.cfg.role, offerAmount });
  if (g.removed.length) ctx.store.event(ctx.dealId, 'LeakBlocked', 'system', { removed: g.removed });
  if (!g.ok) {
    const guard = /disclosure|recording/i.test(g.reason ?? '') ? 'disclosure' : 'redaction';
    ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard, reason: g.reason });
    throw new ToolError(g.reason ?? 'Blocked by guard');
  }
  return g.script;
}

/** Dispatch to Fo, record the action, and either complete it now or schedule polling. */
async function dispatch(ctx: Ctx, stage: Stage, channel: Channel, target: string, objective: string, script: string, constraints: string[]) {
  const started = now();
  const { foTaskId, status } = await ctx.fo.act({
    channel, to: target, objective, script, constraints, mustDisclose: true, maxDurationMin: 10, dealId: ctx.dealId,
  });
  const action = ctx.store.db.insert(actions).values({
    dealId: ctx.dealId, stage, channel, target, objective, foTaskId, startedAt: started,
  }).returning().get();
  ctx.store.markProcessed(`own:${foTaskId}`);
  ctx.store.event(ctx.dealId, 'FoAction', 'fo', { channel, target, objective, foConversationId: foTaskId, script });
  if (status.state === 'working') ctx.store.enqueue('fo_poll', { actionId: action.id, foTaskId, polls: 0 }, { dealId: ctx.dealId, inMs: 15_000 });
  else completeAction(ctx.store, ctx.dealId, action.id, channel, status, { triggerTurn: false });
  return { actionId: action.id, foState: status.state, foReply: status.summary?.slice(0, 500) };
}

export function completeAction(store: Store, dealId: string, actionId: number, channel: string, st: FoStatus, opts: { triggerTurn: boolean }) {
  store.db.update(actions).set({ outcome: st.state, rawResult: JSON.stringify(st), endedAt: now() }).where(eq(actions.id, actionId)).run();
  store.event(dealId, 'ActionCompleted', 'fo', { actionId, channel, outcome: st.state, summary: st.summary ?? '' });
  if (opts.triggerTurn) store.enqueue('turn', { triggerId: `action:${actionId}`, reason: `Fo finished ${channel} action #${actionId} (${st.state}): ${st.summary ?? ''}` }, { dealId });
}

export const HANDLERS: Record<string, (ctx: Ctx, input: Input) => Promise<unknown>> = {
  async propose(ctx, i) {
    const { mandate, stage } = load(ctx);
    if (stage !== 'NEGOTIATING' && stage !== 'AGREED') throw new ToolError(`Cannot make offers in stage ${stage}`);
    const amount = Number(i.amount);
    const channel = i.channel as Channel;
    const fail = (reason: string): never => {
      ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'mandate', reason });
      throw new ToolError(reason);
    };
    if (i.accept) {
      const theirs = ctx.store.lastOffer(ctx.dealId, 'counterparty');
      if (!theirs || theirs.amount !== amount) fail(`accept=true must use the counterparty's last offer amount (${theirs?.amount ?? 'none yet'})`);
      if (!acceptable(ctx.cfg.role, mandate, amount)) fail('That price is outside your mandate; you cannot accept it.');
      if (nearLimit(ctx.cfg.role, mandate, amount) && !ctx.store.approvedWithHash(ctx.dealId, 2, hashPayload({ kind: 'accept', amount })))
        fail(`Accepting $${amount} is near your limit and needs a tier-2 approval first: request_approval({tier: 2, payload: {"kind": "accept", "amount": ${amount}}}).`);
    } else {
      const c = checkOffer(ctx.cfg.role, mandate, amount, ctx.store.lastOffer(ctx.dealId, 'self')?.amount);
      if (!c.ok) fail(c.reason!);
    }
    const target = resolveTarget(ctx, channel);
    const script = await guarded(ctx, mandate, channel, i.message, amount);
    const offer = ctx.store.addOffer(ctx.dealId, 'self', amount, i.terms ?? '', i.rationale ?? '');
    ctx.store.event(ctx.dealId, 'OfferMade', 'claude', { from: 'self', amount, terms: i.terms, accept: Boolean(i.accept), rationale: i.rationale });
    const res = await dispatch(ctx, stage, channel, target, i.accept ? `Accept offer of $${amount}` : `Offer $${amount}`, script,
      [`The price in this message is $${amount}. Do not negotiate or change it.`]);
    return { offerId: offer.id, ...res };
  },

  async fo_act(ctx, i) {
    const { mandate, stage } = load(ctx);
    const channel = i.channel as Channel;
    const target = resolveTarget(ctx, channel, i.target);
    const script = await guarded(ctx, mandate, channel, i.script);
    return dispatch(ctx, stage, channel, target, i.objective, script, i.constraints ?? []);
  },

  async brief_fo(ctx, i) {
    const { mandate } = load(ctx);
    const lastSelf = ctx.store.lastOffer(ctx.dealId, 'self')?.amount ?? mandate.openingOffer;
    const req = Number(i.callAuthority);
    // Bounded authority: at most two rounds of concession from the current offer, and never past the true limit.
    const seller = ctx.cfg.role === 'seller';
    const twoRounds = seller ? lastSelf - 2 * mandate.maxConcessionPerRound : lastSelf + 2 * mandate.maxConcessionPerRound;
    const authority = seller
      ? Math.max(req, twoRounds, mandate.floorOrCeiling)
      : Math.min(req, twoRounds, mandate.floorOrCeiling);
    const text = `${i.instructions}\n\nIf ${ctx.cfg.counterparty.name} or their assistant calls about deal ${ctx.dealId}: ` +
      `you may agree to a price ${seller ? 'at or above' : 'at or below'} $${authority}. Never say this number or hint at it. ` +
      `For anything else (address, payment details, other terms) say you will confirm in writing. Disclose you are an AI assistant.`;
    const { foTaskId, status } = await ctx.fo.brief(ctx.dealId, text);
    ctx.store.markProcessed(`own:${foTaskId}`);
    ctx.store.event(ctx.dealId, 'FoBriefed', 'fo', { authority, requested: req, foConversationId: foTaskId, reply: status.summary });
    return { callAuthority: authority, foReply: status.summary?.slice(0, 300) };
  },

  async request_approval(ctx, i) {
    const tier = Number(i.tier);
    if (![1, 2, 3].includes(tier)) throw new ToolError('tier must be 1, 2 or 3');
    const payload = i.payload ?? {};
    const row = ctx.store.db.insert(approvals).values({
      dealId: ctx.dealId, tier, summary: i.summary, payload, payloadHash: hashPayload(payload), createdAt: now(),
    }).returning().get();
    ctx.store.setStatus(ctx.dealId, 'paused');
    ctx.store.cancelPending(ctx.dealId, 'turn');
    ctx.store.event(ctx.dealId, 'ApprovalRequested', 'claude', { approvalId: row.id, tier, summary: i.summary, payload });
    return { approvalId: row.id, status: 'pending', note: 'Deal is paused until the owner decides. End your turn now.' };
  },

  async schedule_followup(ctx, i) {
    const minutes = Math.max(1, Number(i.inMinutes));
    ctx.store.cancelPending(ctx.dealId, 'turn', (p) => String(p.triggerId).startsWith('followup:'));
    const inMs = minutes * 60_000 * ctx.cfg.timeScale;
    const triggerId = `followup:${Date.now()}`;
    ctx.store.enqueue('turn', { triggerId, reason: `Scheduled follow-up: ${i.reason} (tactic: ${i.tactic})` }, { dealId: ctx.dealId, inMs });
    const runAt = new Date(Date.now() + inMs).toISOString();
    ctx.store.event(ctx.dealId, 'FollowupScheduled', 'claude', { runAt, inMinutes: minutes, reason: i.reason, tactic: i.tactic });
    return { runAt };
  },

  async verify(ctx, i) {
    const r = await verify(ctx.store.db, ctx.dealId, String(i.stage), String(i.expected));
    ctx.store.event(ctx.dealId, 'Verification', 'system', { stage: i.stage, expected: i.expected, ...r });
    return r;
  },

  async transition(ctx, i) {
    const { stage } = load(ctx);
    const to = String(i.to) as Stage;
    if (!STAGES.includes(to)) throw new ToolError(`Unknown stage ${to}`);
    if (!canTransition(stage, to)) throw new ToolError(`Cannot go from ${stage} to ${to}`);
    if (requiresVerification(stage, to) && !ctx.store.lastVerification(ctx.dealId, stage)?.passed)
      throw new ToolError(`Leaving ${stage} needs a passed verify({stage: "${stage}"}) first.`);
    ctx.store.setStage(ctx.dealId, to);
    if (to === 'ABANDONED') ctx.store.setStatus(ctx.dealId, 'abandoned');
    if (to === 'CLOSED') ctx.store.setStatus(ctx.dealId, 'closed');
    ctx.store.event(ctx.dealId, 'Transition', 'claude', { from: stage, to, reason: i.reason });
    return { stage: to };
  },

  async record_commitment(ctx, i) {
    const row = ctx.store.db.insert(commitments).values({ dealId: ctx.dealId, who: i.who, what: i.what, dueAt: i.dueAt || null }).returning().get();
    ctx.store.event(ctx.dealId, 'CommitmentRecorded', 'claude', { id: row.id, who: i.who, what: i.what, dueAt: i.dueAt });
    return { id: row.id };
  },

  async resolve_commitment(ctx, i) {
    const res = ctx.store.db.update(commitments).set({ status: i.status, evidence: i.evidence })
      .where(eq(commitments.id, Number(i.id))).run();
    if (!res.changes) throw new ToolError(`No commitment ${i.id}`);
    ctx.store.event(ctx.dealId, 'CommitmentResolved', 'claude', { id: i.id, status: i.status, evidence: i.evidence });
    return { ok: true };
  },

  async escalate_to_human(ctx, i) {
    ctx.store.setStatus(ctx.dealId, 'paused');
    ctx.store.cancelPending(ctx.dealId, 'turn');
    ctx.store.event(ctx.dealId, 'Escalation', 'claude', { reason: i.reason, options: i.options });
    return { ok: true, note: 'Deal paused for the owner. End your turn now.' };
  },
};
