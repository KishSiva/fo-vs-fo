import { eq } from 'drizzle-orm';
import {
  actions, approvals, commitments, now, checkOffer, acceptable, nearLimit, canTransition, requiresVerification, STAGES, allowedChannels, canPlaceCall,
  type Channel, type ChannelPref, type Mandate, type Stage,
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

/** The owner picks text, call, or auto (proxy's choice of the two) per deal. */
function checkChannel(ctx: Ctx, channel: Channel) {
  if (channel === 'call' && !canPlaceCall(ctx.cfg.role)) {
    ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'channel', reason: 'The seller never places calls; the buyer calls the seller' });
    throw new ToolError(`Sellers never place calls. ${ctx.cfg.counterparty.name} (the buyer) calls you, and your Fo negotiates and closes live on that call. Do not contact them by call; end your turn with schedule_followup.`);
  }
  const pref = (ctx.store.deal(ctx.dealId)?.channelPref ?? 'auto') as ChannelPref;
  const ok = allowedChannels(pref);
  if (!ok.includes(channel)) {
    ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'channel', reason: `${channel} not allowed; owner set channel to ${pref}` });
    throw new ToolError(`The owner set this deal's channel to "${pref}". Use ${ok.join(' or ')}.`);
  }
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

/**
 * Rules for any call about this deal, placed or answered by our Fo. A call settles the deal live:
 * Fo may agree anywhere within the owner's true limit and never defers to a later call.
 */
/** Bump when the briefing changes in a way already-briefed Fos need to hear again. */
export const BRIEF_VERSION = 3;

export function liveCallRules(ctx: Ctx, mandate: Mandate): string[] {
  const seller = ctx.cfg.role === 'seller';
  const cp = ctx.cfg.counterparty.name;
  const current = ctx.store.lastOffer(ctx.dealId, 'self')?.amount ?? mandate.openingOffer;
  return [
    `${ctx.cfg.owner} authorizes you to make a binding agreement for them on the call: you decide and agree, you do not pass offers along.`,
    `Settle deal ${ctx.dealId} on the call. Negotiate directly with ${cp} or their assistant until you agree on price and pickup, or it is clear no deal is possible. When you agree, say the price and pickup back to them and confirm it is a deal.`,
    `Do not say you will pass the offer along, get back to them, check with ${ctx.cfg.owner}, call back later, or schedule another call. Do not put them on hold.`,
    `Your current price is $${current}. You may agree to any price ${seller ? 'at or above' : 'at or below'} $${mandate.floorOrCeiling}. Never say, hint at, or round toward that number.`,
    `Negotiate actively: every time they name a price, answer with a counter-offer that moves ${seller ? 'down' : 'up'} toward them by at most $${mandate.maxConcessionPerRound}, with a reason (condition, comparables, quick pickup, cash). Make as many counters as it takes on the same call. If they ${seller ? 'offer' : 'ask'} a price you may accept, accept it.`,
    'If whoever answers says they cannot negotiate or can only take a message, state your best current offer and pickup terms once, clearly, and end the call. Do not argue with a message-taker.',
    ...(mandate.dealbreakers.length ? [`Dealbreakers: ${mandate.dealbreakers.join('; ')}. If they insist on one, decline it and end the call politely.`] : []),
    'If no price works, give your best final offer once and end the call politely.',
    'Address and payment details are sent in writing after the call; do not give them on the call.',
    'Say you are an AI assistant and that the call may be recorded.',
  ];
}

/**
 * Standing call-answering instruction for our own Fo. Fo answers its phone outside this chat, so it has
 * to read as a lasting instruction with full authority, or Fo just takes a message. The proxy calls this
 * itself (deal start, rule changes, the other side about to dial); the agent can add context via brief_fo.
 */
export async function briefFo(ctx: Ctx, context?: string) {
  const { deal, mandate } = load(ctx);
  const cp = ctx.cfg.counterparty;
  const from = [cp.phone, cp.email].filter(Boolean).join(' / ');
  const text = `STANDING INSTRUCTION for answering the phone, from ${ctx.cfg.owner}. Save it to your memory and apply it until deal ${ctx.dealId} is closed.\n` +
    `Whenever you answer a call from ${cp.name}${from ? ` (${from})` : ''} or from anyone who mentions deal ${ctx.dealId}, you are not a general assistant taking a message: ` +
    `you are ${ctx.cfg.owner}'s negotiator for this ${ctx.cfg.role === 'seller' ? 'sale' : 'purchase'}. You counter and agree live on that call; you never check back with anyone first.\n` +
    `Item: ${deal.item}\n` +
    (mandate.allowedShare.length ? `You may share: ${mandate.allowedShare.join(', ')}.\n` : '') +
    (context ? `Context from ${ctx.cfg.owner}'s negotiation agent: ${context}\n` : '') +
    `Rules on that call:\n${liveCallRules(ctx, mandate).map((r) => `- ${r}`).join('\n')}\n` +
    `If they text about deal ${ctx.dealId}, do not reply yourself: my negotiation agent reads the thread and answers through you shortly.\n` +
    `Do not contact anyone now. Reply confirming you will use this when you answer the phone.`;
  const { foTaskId, status } = await ctx.fo.brief(ctx.dealId, text);
  ctx.store.markProcessed(`own:${foTaskId}`);
  ctx.store.event(ctx.dealId, 'FoBriefed', 'fo', { foConversationId: foTaskId, reply: status.summary, briefVersion: BRIEF_VERSION, by: context ? 'agent' : 'proxy' });
  return { briefed: true, foReply: status.summary?.slice(0, 300) };
}

/**
 * Before our Fo dials, the other side's Fo must already hold its standing instruction, or it answers
 * as a receptionist. The peer proxy briefs on demand when asked.
 */
export async function requirePeerReady(ctx: Ctx) {
  if (!ctx.cfg.peerUrl) return;
  const cp = ctx.cfg.counterparty.name;
  let ready = false;
  try {
    const r = await fetch(`${ctx.cfg.peerUrl}/api/deals/${encodeURIComponent(ctx.dealId)}/readiness`);
    ready = r.ok && Boolean(((await r.json()) as { briefed?: boolean }).briefed);
  } catch { /* peer down: treat as not ready */ }
  if (!ready) {
    ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'peer_ready', reason: `${cp}'s Fo is not briefed for live negotiation yet` });
    throw new ToolError(`${cp}'s Fo is being briefed now so it can negotiate live; do not call yet. schedule_followup({inMinutes: 2}) and place the same call then.`);
  }
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
    checkChannel(ctx, channel);
    const target = resolveTarget(ctx, channel);
    const script = await guarded(ctx, mandate, channel, i.message, amount);
    if (channel === 'call') await requirePeerReady(ctx);
    const offer = ctx.store.addOffer(ctx.dealId, 'self', amount, i.terms ?? '', i.rationale ?? '');
    ctx.store.event(ctx.dealId, 'OfferMade', 'claude', { from: 'self', amount, terms: i.terms, accept: Boolean(i.accept), rationale: i.rationale });
    const res = channel === 'call'
      ? await dispatch(ctx, stage, channel, target, i.accept ? `Accept $${amount} and settle the details` : `Open at $${amount} and settle the deal`, script,
        liveCallRules(ctx, mandate))
      : await dispatch(ctx, stage, channel, target, i.accept ? `Accept offer of $${amount}` : `Offer $${amount}`, script,
        [`The price in this message is $${amount}. Do not negotiate or change it.`]);
    return { offerId: offer.id, ...res };
  },

  async fo_act(ctx, i) {
    const { mandate, stage } = load(ctx);
    const channel = i.channel as Channel;
    checkChannel(ctx, channel);
    const target = resolveTarget(ctx, channel, i.target);
    const script = await guarded(ctx, mandate, channel, i.script);
    if (channel === 'call') await requirePeerReady(ctx);
    const constraints = [...(i.constraints ?? []), ...(channel === 'call' ? liveCallRules(ctx, mandate) : [])];
    return dispatch(ctx, stage, channel, target, i.objective, script, constraints);
  },

  async brief_fo(ctx, i) {
    return briefFo(ctx, String(i.instructions));
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
