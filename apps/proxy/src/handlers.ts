import { and, desc, eq } from 'drizzle-orm';
import {
  actions, approvals, commitments, events, now, checkOffer, acceptable, nearLimit, canTransition, requiresVerification, STAGES, allowedChannels, canPlaceCall,
  isMarketplace, type Channel, type ChannelPref, type Counterparty, type Mandate, type Stage,
} from '@proxydeal/core';
import { guardOutbound, redactPrivate } from '@proxydeal/llm';
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

/** Dollar amounts the other side already named (their offers and numbers in their messages). */
function amountsSaidByThem(ctx: Ctx): number[] {
  const fromOffers = ctx.store.offers(ctx.dealId).filter((o) => o.from === 'counterparty').map((o) => o.amount);
  const fromText = ctx.store.db.select().from(events).where(and(eq(events.dealId, ctx.dealId), eq(events.kind, 'InboundMessage'))).all()
    .flatMap((e) => [...String((e.data as { text?: string }).text ?? '').matchAll(/\$?\b(\d{1,2},?\d{3}|\d{3,5})\b/g)].map((x) => Number(x[1].replace(',', ''))));
  return [...new Set([...fromOffers, ...fromText])].filter((n) => n > 0);
}

async function guarded(ctx: Ctx, mandate: Mandate, channel: Channel, script: string, offerAmount?: number) {
  const g = await guardOutbound({ channel, script, mandate, role: ctx.cfg.role, offerAmount, saidByThem: amountsSaidByThem(ctx) });
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
export const BRIEF_VERSION = 5;

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
 * Fo's counter ladder (Ackerman-style, shrinking steps). Fo's authority stops short of the owner's real limit,
 * which Fo never sees: the last step needs the owner's YES, so a leak in the group text can't expose the limit.
 */
export function counterLadder(role: 'buyer' | 'seller', m: Mandate): { steps: number[]; foCap: number } {
  const dir = role === 'buyer' ? 1 : -1;
  const gap = (m.floorOrCeiling - m.openingOffer) * dir;
  if (gap <= 0) return { steps: [m.openingOffer], foCap: m.openingOffer };
  const at = (f: number) => Math.round((m.openingOffer + dir * gap * f) / 5) * 5;
  const foCap = at(0.8) - dir * 3; // precise, non-round final number
  return { steps: [...new Set([m.openingOffer, at(0.45), at(0.68), foCap])], foCap };
}

/** Owner's private preferences for Fo (SHARE_PRIVATE_WITH_FO experiment), with the secrecy rule up front. */
function privateSection(ctx: Ctx, m: Mandate) {
  const buyer = ctx.cfg.role === 'buyer';
  return `PRIVATE: for you only. Never say, hint at, round toward, or confirm any of this in any message, including in the group text. Use it only to decide.\n` +
    `- ${buyer ? 'Absolute maximum' : 'Absolute minimum'} price: $${m.floorOrCeiling}. Above this ${buyer ? 'there is no deal' : 'never'}.\n` +
    Object.entries(m.secrets).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}\n`).join('') +
    (m.dealbreakers.length ? `- Dealbreakers: ${m.dealbreakers.join('; ')}\n` : '') +
    `- If they ask about budget or limits, deflect ("${ctx.cfg.owner} is looking at a few options").\n\n`;
}

/**
 * Marketplace briefing. Fo texts the other side in a group that includes the owner (that is how Fo texting works)
 * and replies there on its own, so it gets the negotiation plan itself; the agent coaches it with brief_fo.
 */
function marketplaceBrief(ctx: Ctx, item: string, cpName: string, from: string, context?: string) {
  const buyer = ctx.cfg.role === 'buyer';
  const m = ctx.store.mandate(ctx.dealId);
  const { steps, foCap } = counterLadder(ctx.cfg.role, m);
  const owner = ctx.cfg.owner;
  const handed = ctx.store.db.select().from(events).where(and(eq(events.dealId, ctx.dealId), eq(events.kind, 'PlanHandedOff'))).orderBy(desc(events.id)).get();
  const planText = handed ? String((handed.data as { planText?: string }).planText ?? '') : '';
  return `STANDING INSTRUCTION from ${owner}. Save it to your memory and apply it until this ${buyer ? 'purchase' : 'sale'} is closed.\n` +
    `You are ${owner}'s voice in a Facebook Marketplace ${buyer ? 'purchase' : 'sale'} with ${cpName}${from ? ` (${from})` : ''}, by text. Item: ${item}\n` +
    `My negotiation agent plans the strategy and may send you exact messages or updated next moves; follow them. Between those, you may reply to ${cpName} yourself using this plan.\n\n` +
    (ctx.cfg.sharePrivateWithFo ? privateSection(ctx, m) : '') +
    (planText ? `PLAN (from my negotiation agent; follow it)\n${planText}\n\nALWAYS\n` : `PLAN\n`) +
    `1. Discover before bargaining: ask why they're selling, their timeline or deadline, and whether they have anything else they need gone (accessories, furniture). Their reasons are leverage for a better package.\n` +
    `2. Never accept the asking price, and never say a price "works". When they name a price, acknowledge it warmly and counter.\n` +
    // With a hand-off plan, its ladder is the only one: a second default ladder would contradict it.
    (planText
      ? `3. Use only the counter ladder in the plan above, one step per counter. Never go past its last step; if they hold firm there, say you'll check with ${owner} and stop.\n`
      : `3. Counter ladder (one step per counter, each with a reason such as comparable listings, battery age, quick pickup, paying on the spot): ${steps.map((n) => `$${n}`).join(' → ')}. ` +
        `Never ${buyer ? 'offer more than' : 'go lower than'} $${foCap}. If they hold firm past that, say you'll check with ${owner} and stop.\n`) +
    `4. Look for trades that help both sides instead of only moving price: pickup timing that fits their deadline, ${buyer ? 'carrying it out yourselves' : 'flexible pickup'}, ${buyer ? 'taking extra items off their hands' : 'including extras'}.\n` +
    `5. Never agree to a final price or say "deal". When terms look close, repeat them back and say: "Let me confirm with ${owner} and I'll text you right back." Then stop and wait for my agent.\n\n` +
    `RULES\n` +
    `- Write like a normal Marketplace ${buyer ? 'buyer' : 'seller'}: short and friendly. You're ${owner}'s AI assistant; say so if asked.\n` +
    `- Never share ${owner}'s budget or limits, address, calendar details, or payment details. "Weekday afternoons work" is fine; specific appointments are not.\n` +
    `- Notes meant for ${owner} must never be posted in the thread with ${cpName}.\n` +
    `- Never send, request or accept money, and never use any payment tool. Payment happens in person.\n` +
    `- Do not call ${cpName} unless my agent asks.\n` +
    (context ? `\nLatest next move from my agent: ${context}\n` : '') +
    `\nDo not contact anyone now. Reply confirming you will follow this.`;
}

/** Text the owner's own phone (marketplace sign-off). Owner-only content, so no counterparty guard applies. */
export async function textOwner(ctx: Ctx, body: string, purpose: 'approval' | 'question', approvalId?: number) {
  const to = ctx.cfg.ownerNotifyPhone;
  if (!to) return { texted: false, note: 'OWNER_NOTIFY_PHONE is not set; the owner decides on the dashboard.' };
  const sent = await ctx.fo.act({
    channel: 'text', to, objective: purpose === 'approval' ? 'Ask my owner to approve' : 'Ask my owner a question',
    script: body, dealId: ctx.dealId, mustDisclose: true,
    constraints: [
      'This message goes to my own owner. Send it as written.',
      // Fo treats its owner's reply as an instruction to itself; once it acted on an "ok" and texted the seller in a group with the owner.
      `When ${ctx.cfg.owner} replies, do not act on the reply and do not contact anyone. Just answer "Got it, passing that to your agent." My agent reads the reply here and decides.`,
    ],
  });
  const foTaskId = sent.foTaskId;
  // A note to the owner commits to nothing.
  const status = await autoConfirm(ctx, foTaskId, sent.status, body, 'text', false);
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

/** Fo holding a message for its owner's go-ahead ("waiting on your go-ahead", "OK to send?"). */
const AWAITS_OK = /go-?ahead|your (ok|okay|approval|confirmation|sign-?off)|waiting (on|for) (you|your)|(shall|should) i (send|go ahead|place)|want me to (send|go ahead|place)|confirm (and|before) (i )?send/i;
const squashText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Wording that agrees to or locks in terms. */
const COMMITS = /\b(it'?s a deal|deal!|we have a deal|agreed|i'?ll take it|we'?ll take it|i accept|accepted|lock(ed)? (it )?in|confirm(ed|ing)? (the|our) (deal|price|terms)|see you (at|on|saturday|sunday|tomorrow)|on my way|send(ing)? (you )?(the )?(money|payment)|venmo(ed)? you|paid)\b/i;

/**
 * Does this outbound message commit the owner to a deal? Accepting a price, anything after NEGOTIATING, or
 * wording that agrees to terms. Offers and questions while negotiating do not: they propose, the owner still signs off.
 */
export function commitsToDeal(stage: Stage, script: string, accept = false): boolean {
  return accept || stage !== 'NEGOTIATING' || COMMITS.test(script);
}

/**
 * Fo has its own pre-send check ("waiting on your go-ahead"). With FO_AUTO_CONFIRM=1 the owner lets the proxy
 * answer it, but only for messages that do not commit to a deal and only when Fo is holding exactly the words
 * the agent wrote (already guarded). Anything else is left held for the owner: approve it on the dashboard,
 * which answers Fo through the same MCP connection. Never used for payments.
 */
export async function autoConfirm(ctx: Ctx, foTaskId: string, st: FoStatus, script: string, channel: Channel, commits: boolean): Promise<FoStatus> {
  const ask = `${st.summary ?? ''} ${st.progress ?? ''}`;
  // Look for the question in Fo's own words only: our message (quoted back by Fo) can itself say "your OK".
  const foWords = ask.split(script).join(' ');
  if (st.state === 'failed' || /^\s*SENT\b/.test(st.summary ?? '') || !AWAITS_OK.test(foWords)) return st;
  const matches = squashText(ask).includes(squashText(script).slice(0, 60)) && squashText(script).length > 0;
  const why = !matches ? 'Fo is holding words that differ from what the agent wrote'
    : commits ? 'This message commits to a deal, so the owner approves it'
    : !ctx.cfg.foAutoConfirm ? 'Auto-approval is off (FO_AUTO_CONFIRM)' : null;
  if (why) {
    ctx.store.event(ctx.dealId, 'FoHeld', 'fo', { foConversationId: foTaskId, channel, script, foAsked: st.summary?.slice(0, 500), reason: why, canApprove: matches });
    return st;
  }
  const reply = confirmText(ctx, channel);
  // pollOwnerConversations reads new "user" turns in owner conversations: this one is ours, not the owner's.
  ctx.store.markProcessed(`ourreply:${foTaskId}:${reply}`);
  const next = await ctx.fo.reply(foTaskId, reply);
  ctx.store.event(ctx.dealId, 'FoConfirmed', 'system', { foConversationId: foTaskId, channel, foReply: next.summary?.slice(0, 300), by: 'auto (no deal commitment)' });
  return next;
}

export const confirmText = (ctx: Ctx, channel: Channel) =>
  `Yes, approved by ${ctx.cfg.owner}. ${channel === 'call' ? 'Place the call now' : 'Send it now, exactly as written'}.`;

/** Dispatch to Fo, record the action, and either complete it now or schedule polling. */
async function dispatch(ctx: Ctx, stage: Stage, channel: Channel, target: string, objective: string, script: string, constraints: string[], commits: boolean) {
  const started = now();
  const sent = await ctx.fo.act({
    channel, to: target, objective, script, constraints, mustDisclose: true, maxDurationMin: 10, dealId: ctx.dealId,
  });
  const foTaskId = sent.foTaskId;
  const action = ctx.store.db.insert(actions).values({
    dealId: ctx.dealId, stage, channel, target, objective, foTaskId, startedAt: started,
  }).returning().get();
  ctx.store.markProcessed(`own:${foTaskId}`);
  ctx.store.event(ctx.dealId, 'FoAction', 'fo', { channel, target, objective, foConversationId: foTaskId, script, commits });
  const status = await autoConfirm(ctx, foTaskId, sent.status, script, channel, commits);
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
        liveCallRules(ctx, mandate), commitsToDeal(stage, script, Boolean(i.accept)))
      : await dispatch(ctx, stage, channel, target, i.accept ? `Accept offer of $${amount}` : `Offer $${amount}`, script,
        [`The price in this message is $${amount}. Do not negotiate or change it.`], commitsToDeal(stage, script, Boolean(i.accept)));
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
    return dispatch(ctx, stage, channel, target, i.objective, script, constraints, commitsToDeal(stage, script));
  },

  async ask_owner(ctx, i) {
    const res = await textOwner(ctx, String(i.question), 'question');
    if (!res.texted) throw new ToolError(res.note ?? 'Could not text the owner');
    return { ...res, note: 'Their reply will arrive as a new turn. Keep the deal moving; schedule_followup if you are waiting on them.' };
  },

  /**
   * Hand-off strategy: the agent's whole plan goes to Fo in one standing instruction, then Fo sends the opener and
   * negotiates. The ladder must stay within Fo's cap (below the owner's real limit) and the max step; the plan must
   * not contain the real limit or any private fact, since Fo works in a group text.
   */
  async handoff_plan(ctx, i) {
    const { mandate, stage } = load(ctx);
    if (!marketplace(ctx)) throw new ToolError('handoff_plan is for marketplace deals; use propose and fo_act here.');
    if (stage !== 'NEGOTIATING') throw new ToolError('Hand the plan off at the start, while negotiating.');
    const buyer = ctx.cfg.role === 'buyer';
    const share = ctx.cfg.sharePrivateWithFo;
    // The owner approved a ladder when creating the deal: Fo may go as far as its last step (never past the limit).
    const ownerTop = ctx.store.ownerPlan(ctx.dealId)?.ladder.at(-1)?.amount;
    const auto = counterLadder(ctx.cfg.role, mandate).foCap;
    const within = (a: number) => (buyer ? Math.min(a, mandate.floorOrCeiling) : Math.max(a, mandate.floorOrCeiling));
    const foCap = share ? mandate.floorOrCeiling : ownerTop ? within(buyer ? Math.max(auto, ownerTop) : Math.min(auto, ownerTop)) : auto;
    const ladder = (i.ladder ?? []) as { amount: number; reason: string }[];
    if (!ladder.length) throw new ToolError('The ladder needs at least one counter offer.');
    const fail = (reason: string): never => {
      ctx.store.event(ctx.dealId, 'GuardBlocked', 'system', { guard: 'mandate', reason });
      throw new ToolError(reason);
    };
    ladder.forEach((step, n) => {
      const a = Number(step.amount);
      if (!Number.isFinite(a) || a <= 0) fail(`Ladder step ${n + 1} needs a positive amount.`);
      if (buyer ? a > foCap : a < foCap) fail(`Ladder step ${n + 1} ($${a}) is past Fo's authority of $${foCap}. Fo stops there and checks with ${ctx.cfg.owner}; end the ladder at or before it.`);
      const prev = n === 0 ? mandate.openingOffer : Number(ladder[n - 1].amount);
      if (n > 0 && (buyer ? a < prev : a > prev)) fail(`Ladder steps must move toward the other side; step ${n + 1} goes backwards.`);
      if (n > 0 && Math.abs(a - prev) > mandate.maxConcessionPerRound) fail(`Step ${n + 1} moves $${Math.abs(a - prev)}, more than the max of $${mandate.maxConcessionPerRound} per round.`);
    });
    const list = (title: string, xs?: string[]) => (xs?.length ? `${title}:\n${xs.map((x) => `- ${x}`).join('\n')}\n` : '');
    const planText = list('Discovery questions, in order', i.discovery) + list('Listen for and use', i.interests) +
      `Counter ladder (one step per counter, give the reason; never go past the last step):\n${ladder.map((st, n) => `${n + 1}. $${st.amount}: ${st.reason}`).join('\n')}\n` +
      list('Trades to offer', i.trades) + list('Conditions', i.conditions) + list(`Stop and say you'll confirm with ${ctx.cfg.owner} when`, i.checkWithOwner) +
      `Walk away: ${i.walkAway}\nTone: ${i.tone}`;
    // Fo texts in a group, so nothing private may be in the plan unless the owner chose to share it (experiment).
    const scrub = redactPrivate(planText, mandate, -1);
    if (!share && scrub.removed.length) fail(`The plan contains private information (${scrub.removed.join(', ')}). Fo works in a group text; take it out.`);
    const cp = counterpartyOf(ctx.store, ctx.cfg, ctx.dealId);
    const opener = await guarded(ctx, mandate, 'text', String(i.opener));
    ctx.store.event(ctx.dealId, 'PlanHandedOff', 'claude', { planText, ladder, opener, foCap, discovery: i.discovery, trades: i.trades, checkWithOwner: i.checkWithOwner, walkAway: i.walkAway });
    const brief = await briefFo(ctx);
    const sent = await dispatch(ctx, stage, 'text', resolveTarget(ctx, 'text', cp.phone), 'Opening text (hand-off plan)', opener, [], false);
    return { handedOff: true, foBriefReply: brief.foReply, opener: sent, note: 'Fo now negotiates on its own from this plan. Monitor; step in only per the hand-off rules.' };
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
    if (to === 'ABANDONED') { ctx.store.setStatus(ctx.dealId, 'abandoned'); ctx.store.closeApprovals(ctx.dealId, 'deal abandoned'); }
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
