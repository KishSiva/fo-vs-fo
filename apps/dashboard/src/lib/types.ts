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
}

export interface Deal {
  id: string;
  role: Role;
  item: string;
  stage: Stage;
  status: "active" | "paused" | "closed" | "abandoned";
  counterparty: { name: string; kind: "fo" | "human" | "business"; phone?: string; email?: string };
  channelPref: ChannelPref;
  createdAt: string;
}

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

export type Command = "nudge" | "pause" | "resume" | "abandon";
/** auto = the proxy picks text or call per message. */
export type ChannelPref = "auto" | "text" | "call";

/** Full private mandate, only seen while creating a deal. The API never returns it afterwards. */
export interface FullMandate extends Mandate {
  floorOrCeiling: number;
  walkAwayAt: number;
  secrets: Record<string, string>;
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
