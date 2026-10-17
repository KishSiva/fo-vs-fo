export const STAGES = [
  'NEGOTIATING', 'AGREED', 'ADDRESS_EXCHANGE', 'LOGISTICS', 'PICKUP_PENDING',
  'VERIFYING_HANDOFF', 'PAYMENT', 'POST_SALE', 'CLOSED', 'ABANDONED',
] as const;
export type Stage = (typeof STAGES)[number];

export type Role = 'seller' | 'buyer';
export type Channel = 'call' | 'email' | 'text';
/** Owner's channel choice for a deal. auto = the proxy picks text or call each time. */
export type ChannelPref = 'auto' | 'text' | 'call';
export const CHANNEL_PREFS: readonly ChannelPref[] = ['auto', 'text', 'call'];

/** Only the buyer dials. The seller's Fo answers the buyer's call and negotiates there. */
export const canPlaceCall = (role: Role) => role === 'buyer';

/** Channels the proxy may use under a preference. Email is off: the owner wants Fo-to-Fo text or calls. */
export function allowedChannels(pref: ChannelPref): Channel[] {
  return pref === 'auto' ? ['text', 'call'] : [pref];
}
export type Actor = 'claude' | 'fo' | 'human' | 'system';
export type DealStatus = 'active' | 'paused' | 'closed' | 'abandoned';

export interface Counterparty {
  name: string;
  kind: 'fo' | 'human' | 'business';
  phone?: string;
  email?: string;
  foEmail?: string;
}

/**
 * Marketplace mode: the other side is a real person texting by hand (not another Fo).
 * Texts read like Facebook Marketplace messages, and the owner signs off by text before any deal is final.
 */
export const isMarketplace = (c: Pick<Counterparty, 'kind'>) => c.kind === 'human';

export interface Mandate {
  /** Seller: lowest acceptable price. Buyer: highest acceptable price. PRIVATE. */
  floorOrCeiling: number;
  openingOffer: number;
  maxConcessionPerRound: number;
  /** Rounds without progress before walking away. PRIVATE. */
  walkAwayAt: number;
  dealbreakers: string[];
  allowedShare: string[];
  neverShare: string[];
  /** Private facts the proxy knows but must never disclose (home address, card, ...). */
  secrets: Record<string, string>;
}

export interface Offer {
  id: number;
  dealId: string;
  from: 'self' | 'counterparty';
  amount: number;
  terms: string;
  rationale: string;
  ts: string;
}
