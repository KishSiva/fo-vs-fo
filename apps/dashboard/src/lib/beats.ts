import type { DealPlan, Event } from "./types";

/** One step of a deal replay, built from the deal's real events. */
export type Beat =
  | { kind: "seller"; text: string; ts: string }
  | { kind: "us"; text: string; ts: string; by: "claude" | "fo" }
  | { kind: "owner-in"; text: string; ts: string; why: string }
  | { kind: "owner-out"; text: string; ts: string }
  | { kind: "think"; text: string; ts: string; title: string }
  | { kind: "offer"; amount: number; ours: boolean; ts: string }
  | { kind: "stage"; stage: string; ts: string }
  | { kind: "calendar"; text: string; ts: string };

export interface ReplayData {
  item: string;
  counterparty: string;
  plan?: DealPlan;
  beats: Beat[];
  summary: {
    asked: number | null;
    agreed: number | null;
    ownerAsks: number;
    messages: number;
    checked: number;
    minutes: number | null;
  };
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 80);
/** Fo sometimes quotes its own context block back as a message; that's not something anyone texted. */
const isContextDump = (s: string) => /^(recent group messages|directive from)/i.test(s.trim());

/** The text Fo reports it actually sent, when our own copy had a number masked by an over-eager leak check. */
function sentText(script: string, completedSummary?: string): string {
  if (!script.includes("[withheld]") || !completedSummary) return script;
  const pattern = script.split("[withheld]").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(\\$?[\\d,]+)");
  return completedSummary.match(new RegExp(pattern))?.[0] ?? script;
}

const firstSentence = (s: string, max = 240) => {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, "")}…`;
};

/** The listing's title line when it has one, else the item description's first phrase. */
function shortTitle(listing: string, item: string): string {
  const first = listing.split("\n")[0].replace(/\s*[–-]\s*(asking )?(price )?\$[\d,]+.*$/i, "").trim();
  if (first && first.length <= 60) return first;
  return item.split(/[,.(]/)[0].trim();
}

export function buildReplay(events: Event[]): ReplayData {
  const created = events.find((e) => e.kind === "DealCreated")?.data ?? {};
  const completed = new Map<number, string>();
  for (const e of events) if (e.kind === "ActionCompleted") completed.set(e.data.actionId, String(e.data.summary ?? ""));
  const beats: Beat[] = [];
  const said = new Set<string>();
  // Fo's notes and texts to the owner are never part of the seller's thread, even when a later read mislabels them.
  for (const e of events) if (e.kind === "FoNote" || e.kind === "OwnerTexted") said.add(key(String(e.data?.text ?? "")));
  let agreed = false;
  let pendingWhy = "";
  let checked = 0;

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.kind) {
      case "ToolCall": {
        const i = d.input ?? {};
        if (d.tool === "propose") beats.push({ kind: "think", title: `${i.accept ? "Accept" : "Counter at"} $${i.amount}`, text: firstSentence(String(i.rationale ?? "")), ts: e.ts });
        else if (d.tool === "fo_act" && i.objective) beats.push({ kind: "think", title: "Next move", text: firstSentence(String(i.objective)), ts: e.ts });
        else if (d.tool === "handoff_plan") beats.push({ kind: "think", title: "Plan in hand", text: "Starts with questions about the item and the seller's situation before naming any price.", ts: e.ts });
        else if (d.tool === "ask_owner") pendingWhy = "Judgment call";
        else if (d.tool === "request_approval") pendingWhy = "Final sign-off";
        break;
      }
      case "FoAction": {
        if (d.channel !== "text" && d.channel !== "call") break;
        const text = sentText(String(d.script ?? ""), completed.get(d.actionId) ?? [...completed.values()].find((s) => s.includes(String(d.script ?? "").split("[withheld]")[0].slice(0, 30))));
        said.add(key(text));
        checked++;
        beats.push({ kind: "us", text, ts: e.ts, by: "claude" });
        break;
      }
      case "FoOwnMessage": {
        const text = String(d.text ?? "");
        if (!text || said.has(key(text))) break;
        said.add(key(text));
        beats.push({ kind: "us", text, ts: e.ts, by: "fo" });
        break;
      }
      case "InboundMessage": {
        const text = String(d.text ?? "");
        if (!text || isContextDump(text)) break;
        beats.push({ kind: "seller", text, ts: e.ts });
        break;
      }
      case "OwnerTexted":
        beats.push({ kind: "owner-in", text: String(d.text ?? ""), ts: e.ts, why: pendingWhy || "Question" });
        pendingWhy = "";
        break;
      case "OwnerReply": {
        const text = String(d.text ?? "");
        if (!text || isContextDump(text)) break;
        beats.push({ kind: "owner-out", text, ts: e.ts });
        break;
      }
      case "OfferMade":
        // Once agreed, a "new" seller offer can only be an old message read again.
        if (d.amount > 0 && !(agreed && d.from !== "self")) beats.push({ kind: "offer", amount: d.amount, ours: d.from === "self", ts: e.ts });
        break;
      case "Transition":
        if (d.to === "AGREED") agreed = true;
        beats.push({ kind: "stage", stage: d.to, ts: e.ts });
        break;
      case "FoNote":
        if (/calendar/i.test(String(d.text ?? ""))) beats.push({ kind: "calendar", text: String(d.text), ts: e.ts });
        break;
    }
  }

  // Fo can mention the calendar more than once; show the first time.
  const firstCal = beats.findIndex((b) => b.kind === "calendar");
  const ordered = beats.filter((b, i) => b.kind !== "calendar" || i === firstCal);

  const plan = created.plan as DealPlan | undefined;
  const accepted = events.filter((e) => e.kind === "ToolCall" && e.data.tool === "propose" && e.data.input?.accept).at(-1)?.data.input.amount;
  const agreedAt = accepted ?? events.filter((e) => e.kind === "ApprovalRequested").at(-1)?.data.summary?.match(/\$(\d[\d,]*)/)?.[1];
  const firstOut = ordered.find((b) => b.kind === "us")?.ts;
  const end = ordered.find((b) => b.kind === "calendar")?.ts ?? ordered.filter((b) => b.kind === "seller").at(-1)?.ts;
  const sellerAsked = events.find((e) => e.kind === "OfferMade" && e.data.from === "counterparty")?.data.amount;

  return {
    item: shortTitle(String(created.listing ?? ""), String(created.item ?? "")),
    counterparty: String(created.counterparty ?? "Seller"),
    plan,
    beats: ordered,
    summary: {
      asked: sellerAsked ?? plan?.askingPrice ?? null,
      agreed: agreedAt != null ? Number(String(agreedAt).replace(/,/g, "")) : null,
      ownerAsks: ordered.filter((b) => b.kind === "owner-in").length,
      messages: ordered.filter((b) => b.kind === "us" || b.kind === "seller").length,
      checked,
      minutes: firstOut && end ? Math.round((new Date(end).getTime() - new Date(firstOut).getTime()) / 60000) : null,
    },
  };
}
