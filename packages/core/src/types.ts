export const STAGES = [
  'NEGOTIATING', 'AGREED', 'ADDRESS_EXCHANGE', 'LOGISTICS', 'PICKUP_PENDING',
  'VERIFYING_HANDOFF', 'PAYMENT', 'POST_SALE', 'CLOSED', 'ABANDONED',
] as const;
export type Stage = (typeof STAGES)[number];

export type Role = 'seller' | 'buyer';
export type Channel = 'call' | 'email' | 'text';
export type Actor = 'claude' | 'fo' | 'human' | 'system';
export type DealStatus = 'active' | 'paused' | 'closed' | 'abandoned';

export interface Counterparty {
  name: string;
  kind: 'fo' | 'human' | 'business';
  phone?: string;
  email?: string;
  foEmail?: string;
}

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
