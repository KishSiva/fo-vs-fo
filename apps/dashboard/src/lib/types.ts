export type Role = "seller" | "buyer";

export const STAGES = [
  "NEGOTIATING",
  "AGREED",
  "ADDRESS_EXCHANGE",
  "LOGISTICS",
  "PICKUP_PENDING",
  "VERIFYING_HANDOFF",
  "PAYMENT",
  "POST_SALE",
  "CLOSED",
  "ABANDONED",
] as const;
export type Stage = (typeof STAGES)[number];

export interface Health {
  proxyId: string;
  owner: string;
  role: Role;
  capabilities: Record<string, { toolName: string | null; viaAgent: boolean }>;
  worker: { lastBeat: string | null };
  foSignedIn: boolean;
  mockFo?: boolean;
  /** Owner's own cell for sign-off texts (marketplace mode). */
  ownerPhone?: string | null;
  /** This proxy's Fo number (the number the seller texts). */
  foPhone?: string | null;
  paymentsEnabled?: boolean;
}

export interface Deal {
  id: string;
  role: Role;
  item: string;
  stage: Stage;
  status: "active" | "paused" | "closed" | "abandoned";
  counterparty: { name: string; kind: "fo" | "human" | "business"; phone?: string; email?: string };
  channelPref: ChannelPref;
  strategy?: Strategy;
  createdAt: string;
  /** Set when this deal is one of several sellers in a search. */
  huntId?: string | null;
}

/** coach: Claude guides Fo move by move. handoff: Claude plans up front, Fo negotiates. */
export type Strategy = "coach" | "handoff";

export interface Mandate {
  openingOffer: number;
  maxConcessionPerRound: number;
  dealbreakers: string[];
  allowedShare: string[];
  neverShare: string[];
}

export type DealDetail = Deal & { mandate: Mandate };

export type Actor = "claude" | "fo" | "human" | "system";

export interface Event {
  id: number;
  dealId: string;
  ts: string;
  kind: string;
  actor: Actor;
  data: any;
}

export interface Offer {
  id: string;
  dealId: string;
  from: "self" | "counterparty";
  amount: number;
  terms: string;
  rationale: string;
  ts: string;
}

export interface Commitment {
  id: string;
  dealId: string;
  who: string;
  what: string;
  dueAt: string;
  status: "open" | "kept" | "broken";
  evidence?: string;
}

export interface Verification {
  id: string;
  dealId: string;
  stage: string;
  expected: string;
  observed: string;
  passed: boolean;
  evidence: string[];
  ts: string;
}

export interface Approval {
  id: string;
  dealId: string;
  tier: 1 | 2 | 3;
  summary: string;
  payload: any;
  payloadHash: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface ScoreRow {
  persona: string;
  role: string;
  seed: number;
  outcome: "closed" | "abandoned" | "escalated" | "timeout";
  price: number | null;
  mandateOk: boolean;
  leaks: number;
  disclosureOk: boolean;
  approvalsOk: boolean;
  commitmentsTracked: boolean;
  steps: number;
  durationSec: number;
}

export interface Scorecard {
  generatedAt: string | null;
  rows: ScoreRow[];
}

export type Command = "check" | "nudge" | "pause" | "resume" | "abandon";
/** auto = the proxy picks text or call per message. */
export type ChannelPref = "auto" | "text" | "call";

/** Full private mandate, only seen while creating a deal. The API never returns it afterwards. */
export interface FullMandate extends Mandate {
  floorOrCeiling: number;
  walkAwayAt: number;
  secrets: Record<string, string>;
}

export interface ParsedListing {
  item: string;
  summary: string;
  askingPrice: number | null;
  listerName: string | null;
  mandate: FullMandate;
  assumptions: string[];
  warnings: string[];
  role: Role;
  owner: string;
  ownerPhone: string | null;
}

export interface ParsedScenario {
  item: string;
  summary: string;
  seller: FullMandate;
  buyer: FullMandate;
  assumptions: string[];
  warnings: string[];
  names: { seller: string; buyer: string };
}

export type CompKind = "new" | "refurbished" | "used" | "sold" | "listing";

/** Negotiation plan drafted by Claude (with comp research) for the owner to review and edit. */
export interface DealPlan {
  marketRead: string;
  askingPrice: number | null;
  comps: { label: string; price: number; kind: CompKind; url: string }[];
  prices: { open: number; target: number; happy: number; limit: number };
  theirInterests: { signal: string; use: string }[];
  opener: string;
  discovery: string[];
  ladder: { amount: number; reason: string }[];
  trades: string[];
  tactics: string[];
  dealbreakers: string[];
  niceToHaves: string[];
  checkWithOwner: string[];
  walkAway: string;
}

export interface PlanResult {
  plan: DealPlan;
  warnings: string[];
  searches: number;
  queries: string[];
}

export interface Hunt {
  id: string;
  item: string;
  status: "active" | "won";
  winnerDealId: string | null;
  createdAt: string;
}

export interface HuntSeller extends Deal {
  theirs: number | null;
  ours: number | null;
  pendingApproval: boolean;
  lastMessage: { from: "them" | "us"; text: string; ts: string } | null;
}

export interface HuntDetail {
  hunt: Hunt;
  plan: DealPlan | null;
  sellers: HuntSeller[];
}
