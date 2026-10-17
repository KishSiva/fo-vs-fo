import { eq } from 'drizzle-orm';
import {
  actions, approvals, commitments, now, checkOffer, acceptable, nearLimit, canTransition, requiresVerification, STAGES, allowedChannels, canPlaceCall,
  isMarketplace, type Channel, type ChannelPref, type Counterparty, type Mandate, type Stage,
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

/** Who we negotiate with on this deal: the deal's own contact (pasted per deal) wins over the env default. */
export function counterpartyOf(store: Store, cfg: Config, dealId: string): Counterparty {
  const c = store.deal(dealId)?.counterparty;
  return {
    name: c?.name || cfg.counterparty.name,
    kind: c?.kind ?? 'fo',
    phone: c?.phone || cfg.counterparty.phone,
    email: c?.email || cfg.counterparty.email,
  };
}

const marketplace = (ctx: Ctx) => isMarketplace(counterpartyOf(ctx.store, ctx.cfg, ctx.dealId));
export const normPhone = (s: string) => s.replace(/[\s().-]/g, '').toLowerCase();

/** The owner picks text, call, or auto (proxy's choice of the two) per deal. */
function checkChannel(ctx: Ctx, channel: Channel) {
  if (channel === 'call' && !canPlaceCall(ctx.cfg.role)) {
    ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'channel', reason: 'The seller never places calls; the buyer calls the seller' });
    throw new ToolError(`Sellers never place calls. ${counterpartyOf(ctx.store, ctx.cfg, ctx.dealId).name} (the buyer) calls you, and your Fo negotiates and closes live on that call. Do not contact them by call; end your turn with schedule_followup.`);
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
  const cp = counterpartyOf(ctx.store, ctx.cfg, ctx.dealId);
  const known = [cp.phone, cp.email].filter(Boolean) as string[];
  const t = target ?? (channel === 'email' ? cp.email : cp.phone);
  if (!t) throw new ToolError(`No ${channel} address on file for the counterparty`);
  if (!known.some((k) => normPhone(k) === normPhone(t))) throw new ToolError(`Unknown target ${t}. Only the counterparty (${known.join(', ')}) may be contacted; escalate_to_human for anyone else.`);
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
  const cp = counterpartyOf(ctx.store, ctx.cfg, ctx.dealId).name;
  const current = ctx.store.lastOffer(ctx.dealId, 'self')?.amount ?? mandate.openingOffer;
  if (marketplace(ctx)) return marketplaceCallRules(ctx, mandate, cp, current, seller);
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
 * A live call with a real person about a Marketplace listing. Fo negotiates on the call, but the owner signs off
 * on the final price, so Fo ends on a tentative agreement and the agent confirms by text after the owner's YES.
 */
function marketplaceCallRules(ctx: Ctx, mandate: Mandate, cp: string, current: number, seller: boolean): string[] {
  const owner = ctx.cfg.owner;
  return [
    `You are calling ${cp} about their Facebook Marketplace listing, on behalf of ${owner}. Be friendly and natural, like a normal ${seller ? 'seller' : 'buyer'}.`,
    `Ask a few questions first: why they're selling, their timeline, and whether they have anything else they need gone. Look for trades that help both sides (pickup timing, carrying it out, extra items).`,
    `Your current price is $${current}. You may work toward any price ${seller ? 'at or above' : 'at or below'} $${mandate.floorOrCeiling}, moving at most $${mandate.maxConcessionPerRound} per counter, each with a reason. Never say, hint at, or round toward that limit.`,
    `Do not finalize. When you reach terms that work, repeat the price, items and pickup time back to them and say: "Let me confirm with ${owner} and I'll text you right back to lock it in."`,
    ...(mandate.dealbreakers.length ? [`Dealbreakers: ${mandate.dealbreakers.join('; ')}. If they insist on one, decline politely.`] : []),
    'Never send, request or accept money on the call. Payment happens in person at pickup. Do not give addresses on the call.',
    'Keep it under 10 minutes. Say you are an AI assistant and that the call may be recorded.',
  ];
}

/**
 * Standing call-answering instruction for our own Fo. Fo answers its phone outside this chat, so it has
 * to read as a lasting instruction with full authority, or Fo just takes a message. The proxy calls this
 * itself (deal start, rule changes, the other side about to dial); the agent can add context via brief_fo.
 */
export async function briefFo(ctx: Ctx, context?: string) {
  const { deal, mandate } = load(ctx);
  const cp = counterpartyOf(ctx.store, ctx.cfg, ctx.dealId);
  const from = [cp.phone, cp.email].filter(Boolean).join(' / ');
  const text = isMarketplace(cp) ? marketplaceBrief(ctx, deal.item, cp.name, from, context) : `STANDING INSTRUCTION for answering the phone, from ${ctx.cfg.owner}. Save it to your memory and apply it until deal ${ctx.dealId} is closed.\n` +
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
 * Marketplace deals are text-only with a person, so Fo needs no price authority: it must stay quiet and let
 * the negotiation agent write every reply, or Fo's own cautious replies undercut the negotiation.
 */
function marketplaceBrief(ctx: Ctx, item: string, cpName: string, from: string, context?: string) {
  return `STANDING INSTRUCTION from ${ctx.cfg.owner}. Save it to your memory and apply it until this ${ctx.cfg.role === 'buyer' ? 'purchase' : 'sale'} is closed.\n` +
    `My negotiation agent is handling a Facebook Marketplace ${ctx.cfg.role === 'buyer' ? 'purchase' : 'sale'} with ${cpName}${from ? ` (${from})` : ''}: ${item}\n` +
    `- If ${cpName} texts you, do not reply yourself and do not negotiate. My agent reads the thread and replies through you within a minute.\n` +
    `- When my agent asks you to send a text, send exactly the words it gives you.\n` +
    `- Never send, request or accept money, and never use any payment tool for this. Payment, if any, happens in person.\n` +
    `- Do not call ${cpName} unless my agent asks.\n` +
    (context ? `Context from my agent: ${context}\n` : '') +
    `Do not contact anyone now. Reply confirming you will follow this.`;
}

/** Text the owner's own phone (marketplace sign-off). Owner-only content, so no counterparty guard applies. */
export async function textOwner(ctx: Ctx, body: string, purpose: 'approval' | 'question', approvalId?: number) {
  const to = ctx.cfg.ownerNotifyPhone;
  if (!to) return { texted: false, note: 'OWNER_NOTIFY_PHONE is not set; the owner decides on the dashboard.' };
  const { foTaskId, status } = await ctx.fo.act({
    channel: 'text', to, objective: purpose === 'approval' ? 'Ask my owner to approve' : 'Ask my owner a question',
    script: body, constraints: ['This message goes to my own owner. Send it as written.'], mustDisclose: true, dealId: ctx.dealId,
  });
  ctx.store.markProcessed(`own:${foTaskId}`);
  ctx.store.event(ctx.dealId, 'OwnerTexted', 'fo', { to, purpose, text: body, approvalId, foConversationId: foTaskId, foState: status.state });
  return { texted: true };
}

/**
 * Before our Fo dials, the other side's Fo must already hold its standing instruction, or it answers
 * as a receptionist. The peer proxy briefs on demand when asked.
 */
export async function requirePeerReady(ctx: Ctx) {
  // A marketplace counterparty is a person on their own phone: there is no peer proxy to brief.
  if (!ctx.cfg.peerUrl || marketplace(ctx)) return;
  const cp = counterpartyOf(ctx.store, ctx.cfg, ctx.dealId).name;
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
      const signedOff = ctx.store.approvedAccept(ctx.dealId, amount);
      if (marketplace(ctx) && !signedOff)
        fail(`${ctx.cfg.owner} signs off on every final price in this deal. request_approval({tier: 2, summary, payload: {"kind": "accept", "amount": ${amount}}}) first; the proxy texts them.`);
      if (nearLimit(ctx.cfg.role, mandate, amount) && !signedOff)
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

  async ask_owner(ctx, i) {
    const res = await textOwner(ctx, String(i.question), 'question');
    if (!res.texted) throw new ToolError(res.note ?? 'Could not text the owner');
    return { ...res, note: 'Their reply will arrive as a new turn. Keep the deal moving; schedule_followup if you are waiting on them.' };
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
    const sms = await textOwner(ctx, `${i.summary}\nReply YES to approve or NO to decline (or reply with what you'd like instead).`, 'approval', row.id)
      .catch((e) => ({ texted: false, note: `Texting the owner failed (${e instanceof Error ? e.message : e}); they can decide on the dashboard.` }));
    return { approvalId: row.id, status: 'pending', ownerTexted: sms.texted, note: 'Deal is paused until the owner decides. End your turn now.' };
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
    if (to === 'AGREED' && marketplace(ctx) && !ctx.store.approvedOfKind(ctx.dealId, 2, 'accept'))
      throw new ToolError(`${ctx.cfg.owner} has not signed off on the final terms. request_approval({tier: 2, summary, payload: {"kind": "accept", "amount": <price>}}) first.`);
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
