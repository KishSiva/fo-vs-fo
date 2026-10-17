import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  DollarSign,
  EyeOff,
  Gavel,
  Inbox,
  Mail,
  MessageSquare,
  Phone,
  Send,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Actor, Event } from "@/lib/types";
import { cn, money, relative, time } from "@/lib/utils";
import { JsonView, StageBadge } from "./common";
import { Badge } from "./ui/badge";

export const ACTOR_STYLE: Record<Actor, { dot: string; text: string; label: string }> = {
  claude: { dot: "bg-violet-500", text: "text-violet-700", label: "Claude" },
  fo: { dot: "bg-sky-500", text: "text-sky-700", label: "Fo" },
  human: { dot: "bg-emerald-500", text: "text-emerald-700", label: "Human" },
  system: { dot: "bg-slate-400", text: "text-slate-600", label: "System" },
};

export const CHANNEL_ICON: Record<string, LucideIcon> = { email: Mail, text: MessageSquare, call: Phone };
const channelIcon = (c: string) => CHANNEL_ICON[c] ?? Send;

type Tone = "default" | "red" | "amber" | "green" | "blue" | "violet";
interface Rendered {
  icon: LucideIcon;
  tone?: Tone;
  title: ReactNode;
  body?: ReactNode;
}

const TONE: Record<Tone, { card: string; icon: string }> = {
  default: { card: "border-slate-200 bg-white", icon: "bg-slate-100 text-slate-600" },
  red: { card: "border-red-300 bg-red-50 ring-1 ring-red-200", icon: "bg-red-600 text-white" },
  amber: { card: "border-amber-300 bg-amber-50", icon: "bg-amber-500 text-white" },
  green: { card: "border-emerald-300 bg-emerald-50", icon: "bg-emerald-600 text-white" },
  blue: { card: "border-sky-200 bg-sky-50/60", icon: "bg-sky-100 text-sky-700" },
  violet: { card: "border-slate-200 bg-white", icon: "bg-violet-100 text-violet-700" },
};

const Muted = ({ children }: { children: ReactNode }) => <span className="text-slate-500">{children}</span>;
const Quote = ({ children }: { children: ReactNode }) => (
  <div className="mt-1 whitespace-pre-wrap border-l-2 border-slate-300 pl-2 text-slate-700">{children}</div>
);
const Clamp = ({ text }: { text: string }) =>
  text.length > 280 ? (
    <details className="mt-1 text-slate-700">
      <summary className="cursor-pointer whitespace-pre-wrap">{text.slice(0, 280)}… <span className="text-xs text-sky-700">more</span></summary>
      <div className="whitespace-pre-wrap">{text}</div>
    </details>
  ) : (
    <div className="mt-1 whitespace-pre-wrap text-slate-700">{text}</div>
  );
const Collapsible = ({ label, value }: { label: string; value: unknown }) => (
  <details className="mt-1">
    <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">{label}</summary>
    <JsonView value={value} className="mt-1" />
  </details>
);

function render(e: Event): Rendered {
  const d = e.data ?? {};
  switch (e.kind) {
    case "ModelTurn":
      return {
        icon: Bot,
        tone: "violet",
        title: (
          <>
            Claude turn <Muted>· {d.model}</Muted>
          </>
        ),
        body: (
          <>
            {d.text && <Clamp text={String(d.text)} />}
            {Array.isArray(d.toolCalls) && d.toolCalls.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {d.toolCalls.map((t: any, i: number) => (
                  <Badge key={i} variant="violet" className="font-mono">
                    <Wrench className="h-3 w-3" /> {t?.name ?? t?.tool ?? String(t)}
                  </Badge>
                ))}
              </div>
            )}
          </>
        ),
      };
    case "ToolCall":
      return {
        icon: Wrench,
        title: (
          <>
            Tool call <code className="font-mono text-violet-700">{d.tool}</code>
          </>
        ),
        body: <Collapsible label="input" value={d.input} />,
      };
    case "ToolResult":
      return {
        icon: d.isError ? CircleX : Wrench,
        tone: d.isError ? "red" : "default",
        title: (
          <>
            Tool result <code className="font-mono">{d.tool}</code> {d.isError && <Badge variant="red">error</Badge>}
          </>
        ),
        body: <Collapsible label="output" value={d.output} />,
      };
    case "FoAction":
      return {
        icon: channelIcon(d.channel),
        tone: "blue",
        title: (
          <>
            Fo {d.channel} <ArrowRight className="inline h-3 w-3" /> <span className="font-semibold">{d.target}</span>
          </>
        ),
        body: d.objective && <div className="mt-1 text-slate-700">{d.objective}</div>,
      };
    case "ActionCompleted":
      return {
        icon: channelIcon(d.channel),
        tone: "blue",
        title: (
          <>
            {d.channel} completed <Badge variant={/fail|error|no.?answer/i.test(d.outcome ?? "") ? "red" : "green"}>{d.outcome}</Badge>
          </>
        ),
        body: d.summary && <Clamp text={String(d.summary)} />,
      };
    case "CallTranscript": {
      const turns = (d.turns ?? []) as { side: "caller" | "callee"; text: string; at: string }[];
      return {
        icon: Phone,
        tone: "blue",
        title: (
          <>
            Call <span className="font-semibold">{d.caller}</span>'s Fo <ArrowRight className="inline h-3 w-3" />{" "}
            <span className="font-semibold">{d.callee}</span>'s Fo <Muted>· {turns.length} lines</Muted>
          </>
        ),
        body: (
          <div className="mt-1 space-y-1 rounded-md bg-slate-50 p-2 text-xs">
            {turns.map((t, i) => (
              <div key={i}>
                <span className="font-semibold text-slate-600">{t.side === "caller" ? d.caller : d.callee}:</span>{" "}
                <span className="text-slate-800">{t.text}</span>
              </div>
            ))}
          </div>
        ),
      };
    }
    case "CallShared":
      return {
        icon: Phone,
        title: (
          <>
            Sent call transcript <Muted>to</Muted> <span className="font-semibold">{d.to}</span>
          </>
        ),
      };
    case "InboundMessage":
      return {
        icon: Inbox,
        title: (
          <>
            Inbound {d.channel} <Muted>from</Muted> <span className="font-semibold">{d.from}</span>
          </>
        ),
        body: <Quote>{d.text}</Quote>,
      };
    case "OfferMade":
      return {
        icon: DollarSign,
        tone: d.from === "self" ? "blue" : "default",
        title: (
          <>
            {d.from === "self" ? "We offered" : "Counterparty offered"}{" "}
            <span className="text-base font-bold tabular-nums">{money(d.amount)}</span>
          </>
        ),
        body: d.terms && <div className="mt-1 text-slate-600">{typeof d.terms === "string" ? d.terms : JSON.stringify(d.terms)}</div>,
      };
    case "Transition":
      return {
        icon: ArrowRight,
        title: (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StageBadge stage={d.from ?? "?"} /> <ArrowRight className="h-3.5 w-3.5" /> <StageBadge stage={d.to ?? "?"} />
          </span>
        ),
        body: d.reason && <div className="mt-1 text-slate-600">{d.reason}</div>,
      };
    case "GuardBlocked":
      return {
        icon: ShieldAlert,
        tone: "red",
        title: (
          <span className="text-red-800">
            Guard blocked action <Badge variant="red" className="font-mono uppercase">{d.guard}</Badge>
          </span>
        ),
        body: <div className="mt-1 font-medium text-red-900">{d.reason}</div>,
      };
    case "LeakBlocked":
      return {
        icon: EyeOff,
        tone: "red",
        title: <span className="text-red-800">Leak redacted before sending ({(d.removed ?? []).length} item{(d.removed ?? []).length === 1 ? "" : "s"})</span>,
        body: (
          <div className="mt-1 flex flex-wrap gap-1">
            {(d.removed ?? []).map((r: string, i: number) => (
              <Badge key={i} variant="red" className="font-mono line-through">
                {r}
              </Badge>
            ))}
          </div>
        ),
      };
    case "ApprovalRequested":
      return {
        icon: Gavel,
        tone: "amber",
        title: (
          <span className="text-amber-900">
            Approval requested <TierBadge tier={d.tier} />
          </span>
        ),
        body: (
          <div className="mt-1 text-amber-950">
            {d.summary}{" "}
            <Link to="/approvals" className="text-xs font-semibold text-amber-700 underline">
              review →
            </Link>
          </div>
        ),
      };
    case "ApprovalDecided": {
      const ok = d.decision === "approved";
      return {
        icon: ok ? CircleCheck : CircleX,
        tone: ok ? "green" : "red",
        title: <>Owner {ok ? "approved" : "denied"} request</>,
        body: d.approvalId && <Muted>approval {String(d.approvalId).slice(0, 8)}</Muted>,
      };
    }
    case "Verification":
      return {
        icon: d.passed ? CircleCheck : CircleX,
        tone: d.passed ? "green" : "red",
        title: (
          <>
            Verification {d.passed ? "passed" : "FAILED"} <StageBadge stage={d.stage ?? "?"} />
          </>
        ),
        body: <ExpectedObserved expected={d.expected} observed={d.observed} />,
      };
    case "FollowupScheduled":
      return {
        icon: Clock,
        title: (
          <>
            Follow-up scheduled <Muted>{d.runAt ? relative(d.runAt) : ""}</Muted> {d.tactic && <Badge>{d.tactic}</Badge>}
          </>
        ),
        body: d.reason && <div className="mt-1 text-slate-600">{d.reason}</div>,
      };
    case "Escalation":
      return {
        icon: AlertTriangle,
        tone: "amber",
        title: <span className="text-amber-900">Escalated to owner</span>,
        body: (
          <>
            <div className="mt-1 text-amber-950">{d.reason}</div>
            {Array.isArray(d.options) && (
              <ul className="mt-1 list-inside list-disc text-slate-700">
                {d.options.map((o: any, i: number) => (
                  <li key={i}>{typeof o === "string" ? o : JSON.stringify(o)}</li>
                ))}
              </ul>
            )}
          </>
        ),
      };
    default:
      return { icon: CircleDot, title: e.kind, body: <Collapsible label="data" value={d} /> };
  }
}

export function TierBadge({ tier }: { tier: number }) {
  const v = tier >= 3 ? "red" : tier === 2 ? "amber" : "default";
  return <Badge variant={v}>Tier {tier}{tier >= 3 ? " · money" : ""}</Badge>;
}

export function ExpectedObserved({ expected, observed }: { expected: unknown; observed: unknown }) {
  const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
      <span className="text-slate-500">expected</span>
      <span className="font-mono">{s(expected)}</span>
      <span className="text-slate-500">observed</span>
      <span className="font-mono">{s(observed)}</span>
    </div>
  );
}

export function EventItem({ event, animate }: { event: Event; animate?: boolean }) {
  const r = render(event);
  const tone = TONE[r.tone ?? "default"];
  const actor = ACTOR_STYLE[event.actor] ?? ACTOR_STYLE.system;
  const Icon = r.icon;
  return (
    <li className={cn("relative flex gap-3 pl-1", animate && "animate-event-in")}>
      <div className={cn("z-10 mt-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-slate-50", tone.icon)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className={cn("min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm", tone.card)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 font-medium text-slate-900">{r.title}</div>
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500">
            <span className={cn("h-2 w-2 rounded-full", actor.dot)} />
            <span className={cn("font-medium", actor.text)}>{actor.label}</span>
            <span className="tabular-nums">{time(event.ts)}</span>
          </div>
        </div>
        {r.body}
        {r.icon !== CircleDot && (
          <details className="mt-1">
            <summary className="w-fit cursor-pointer text-[10px] uppercase tracking-wide text-slate-400 hover:text-slate-600">raw</summary>
            <JsonView value={event} className="mt-1" />
          </details>
        )}
      </div>
    </li>
  );
}
