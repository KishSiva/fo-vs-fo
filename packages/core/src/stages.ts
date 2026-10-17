import type { Stage } from './types.js';

export interface StageSpec {
  next: Stage[];
  /** Tools Claude may call in this stage (beyond the always-allowed set). */
  tools: string[];
  /** What the verifier must observe before leaving this stage. */
  exitCriteria: string;
  /** Minutes without progress before a follow-up job fires. */
  timeoutMin: number;
}

// brief_fo only instructs our own Fo (no outbound contact), so it is safe in every open stage.
const ALWAYS = ['schedule_followup', 'verify', 'record_commitment', 'resolve_commitment', 'escalate_to_human', 'request_approval', 'transition', 'brief_fo'];

export const STAGE_SPECS: Record<Stage, StageSpec> = {
  NEGOTIATING: { next: ['AGREED', 'ABANDONED'], tools: ['propose', 'fo_act'], exitCriteria: 'Counterparty explicitly accepted a specific price in their own message', timeoutMin: 120 },
  AGREED: { next: ['ADDRESS_EXCHANGE', 'NEGOTIATING', 'ABANDONED'], tools: ['fo_act'], exitCriteria: 'Both sides confirmed price and terms in writing', timeoutMin: 120 },
  ADDRESS_EXCHANGE: { next: ['LOGISTICS', 'ABANDONED'], tools: ['fo_act'], exitCriteria: 'Pickup address shared after tier-1 approval and acknowledged', timeoutMin: 240 },
  LOGISTICS: { next: ['PICKUP_PENDING', 'ABANDONED'], tools: ['fo_act'], exitCriteria: 'Courier booking reference observed', timeoutMin: 240 },
  PICKUP_PENDING: { next: ['VERIFYING_HANDOFF', 'LOGISTICS', 'ABANDONED'], tools: ['fo_act'], exitCriteria: 'Courier confirmed pickup', timeoutMin: 720 },
  VERIFYING_HANDOFF: { next: ['PAYMENT', 'POST_SALE'], tools: ['fo_act'], exitCriteria: 'Buyer confirmed receipt in their own message', timeoutMin: 240 },
  PAYMENT: { next: ['POST_SALE'], tools: ['fo_act'], exitCriteria: 'Charge record observed for the agreed amount', timeoutMin: 240 },
  POST_SALE: { next: ['CLOSED'], tools: ['fo_act'], exitCriteria: 'No open complaints after the post-sale window', timeoutMin: 1440 },
  CLOSED: { next: [], tools: [], exitCriteria: '', timeoutMin: 0 },
  ABANDONED: { next: [], tools: [], exitCriteria: '', timeoutMin: 0 },
};

export function allowedTools(stage: Stage): string[] {
  const s = STAGE_SPECS[stage];
  return s.next.length ? [...s.tools, ...ALWAYS] : [];
}

export function canTransition(from: Stage, to: Stage): boolean {
  return STAGE_SPECS[from].next.includes(to);
}

/** Stages whose completion requires a passed verification row. ABANDONED never does. */
export function requiresVerification(from: Stage, to: Stage): boolean {
  return to !== 'ABANDONED' && !(from === 'AGREED' && to === 'NEGOTIATING') && !(from === 'PICKUP_PENDING' && to === 'LOGISTICS');
}
