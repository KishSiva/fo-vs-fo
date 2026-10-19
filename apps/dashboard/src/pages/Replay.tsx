import { BellRing, Brain, CalendarCheck, Check, Lock, Pause, Play, RotateCcw, Search, ShieldCheck, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PriceTrack } from "@/components/PriceTrack";
import { useEvents } from "@/lib/api";
import { buildReplay, type Beat } from "@/lib/beats";
import { cn, money } from "@/lib/utils";

const STAGES = [
  { key: "NEGOTIATING", label: "Negotiating" },
  { key: "AGREED", label: "Agreed" },
  { key: "ADDRESS_EXCHANGE", label: "Pickup set" },
];

/** How long to hold on a beat before showing the next one (ms, before the speed factor). */
function holdFor(b: Beat): number {
  switch (b.kind) {
    case "seller":
    case "us":
    case "owner-out":
      return 1300 + Math.min(b.text.length * 22, 2600);
    case "owner-in":
      return 2600 + Math.min(b.text.length * 15, 2000);
    case "think":
      return 2000 + Math.min(b.text.length * 12, 1800);
    case "calendar":
      return 3500;
    default:
      return 500;
  }
}

const clock = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";

function Phone({ title, subtitle, children, glow, typing, footer }: { title: string; subtitle: string; children: ReactNode; glow?: boolean; typing?: boolean; footer?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  });
  return (
    <div className={cn("flex h-full flex-col overflow-hidden rounded-[2.2rem] border-[7px] border-slate-900 bg-white shadow-2xl transition-shadow duration-500", glow && "shadow-amber-400/60 ring-4 ring-amber-300")}>
      <div className="flex shrink-0 flex-col items-center border-b border-slate-100 bg-slate-50 pb-2 pt-3">
        <div className="mb-2 h-1.5 w-16 rounded-full bg-slate-300" />
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className="text-[11px] text-slate-500">{subtitle}</div>
      </div>
      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {children}
        {typing && (
          <div className="flex w-14 items-center justify-center gap-1 rounded-2xl bg-slate-100 px-3 py-2.5">
            {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${i * 120}ms` }} />)}
          </div>
        )}
      </div>
      {footer}
    </div>
  );
}

function Bubble({ side, children, label, tone = "blue", ts }: { side: "left" | "right"; children: ReactNode; label?: ReactNode; tone?: "blue" | "slate" | "green" | "violet"; ts?: string }) {
  const colors = { blue: "bg-sky-600 text-white", slate: "bg-slate-100 text-slate-900", green: "bg-emerald-600 text-white", violet: "bg-violet-600 text-white" };
  return (
    <div className={cn("animate-event-in flex flex-col", side === "right" ? "items-end" : "items-start")}>
      {label && <div className="mb-0.5 px-1 text-[10px] font-medium text-slate-400">{label}</div>}
      <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-snug", colors[tone], side === "right" ? "rounded-br-md" : "rounded-bl-md")}>{children}</div>
      {ts && <div className="mt-0.5 px-1 text-[10px] text-slate-400">{clock(ts)}</div>}
    </div>
  );
}

export function ReplayPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const speed = Number(params.get("speed") ?? 1) || 1;
  const recording = params.get("chrome") === "0";
  const events = useEvents(id);
  const data = useMemo(() => buildReplay(events.data ?? []), [events.data]);
  const intro = data.plan ? 1 : 0;
  const total = intro + data.beats.length;
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(params.get("autoplay") === "1");
  const [started, setStarted] = useState(false);

  // Advance one beat at a time; the intro (comps) holds a little longer.
  useEffect(() => {
    if (!playing || !events.data || shown >= total) {
      if (shown >= total && total > 0) setPlaying(false);
      return;
    }
    const hold = shown < intro ? 300 : shown === intro && intro ? 6500 : holdFor(data.beats[shown - intro - 1] ?? data.beats[0]);
    const t = setTimeout(() => { setShown((n) => n + 1); setStarted(true); }, (started ? hold : 600) / speed);
    return () => clearTimeout(t);
  }, [playing, shown, total, intro, data.beats, speed, started, events.data]);

  const visible = data.beats.slice(0, Math.max(0, shown - intro));
  const next = playing ? data.beats[shown - intro] : undefined;
  const done = total > 0 && shown >= total;
  const last = visible.at(-1);
  const stage = [...visible].reverse().find((b) => b.kind === "stage")?.stage ?? "NEGOTIATING";
  const offers = visible.filter((b): b is Extract<Beat, { kind: "offer" }> => b.kind === "offer").map((o) => ({ amount: o.amount, ours: o.ours }));
  const lastOffer = (ours: boolean) => [...offers].reverse().find((o) => o.ours === ours)?.amount;
  const ownerHot = last?.kind === "owner-in" || next?.kind === "owner-out";
  const calendar = visible.find((b) => b.kind === "calendar");
  const thoughts = visible.filter((b): b is Extract<Beat, { kind: "think" }> => b.kind === "think");
  const stageIdx = Math.max(0, STAGES.findIndex((s) => s.key === stage));
  const s = data.summary;
  const lo = Math.min(data.plan?.prices.open ?? Infinity, ...offers.map((o) => o.amount));
  const hi = Math.max(s.asked ?? 0, data.plan?.prices.limit ?? 0);
  const nearComps = (data.plan?.comps ?? []).filter((c) => c.price >= lo * 0.75 && c.price <= hi * 1.4);

  if (events.isPending) return <div className="p-10 text-slate-500">Loading deal…</div>;
  if (!events.data?.length) return <div className="p-10 text-slate-500">No events for {id}.</div>;

  return (
    <div className="flex h-screen flex-col gap-3 overflow-hidden bg-gradient-to-br from-slate-100 via-slate-50 to-sky-50 p-5 text-slate-900">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-sky-700">ProxyDeal · replay of a live negotiation</div>
          <h1 className="text-2xl font-semibold tracking-tight">{params.get("title") ?? data.item}</h1>
        </div>
        <div className="flex items-center gap-5">
          <ol className="flex items-center gap-2">
            {STAGES.map((st, i) => (
              <li key={st.key} className="flex items-center gap-2">
                <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors", i < stageIdx ? "bg-emerald-100 text-emerald-800" : i === stageIdx ? "bg-slate-900 text-white" : "bg-white text-slate-400")}>
                  {i < stageIdx && <Check className="h-3 w-3" />} {st.label}
                </span>
                {i < STAGES.length - 1 && <span className="h-px w-4 bg-slate-300" />}
              </li>
            ))}
          </ol>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Real time</div>
            <div className="whitespace-nowrap font-mono text-lg font-semibold tabular-nums">{clock(last && "ts" in last ? last.ts : data.beats[0] && "ts" in data.beats[0] ? data.beats[0].ts : undefined)}</div>
          </div>
        </div>
      </header>

      {/* Price track */}
      {data.plan && (
        <div className="shrink-0 rounded-2xl border border-slate-200 bg-white/90 px-5 pt-3 shadow-sm">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wide text-slate-500">Price</span>
            <span className="flex gap-4 text-slate-500">
              <span className="text-sm">Seller <b className="text-xl text-slate-900 tabular-nums">{money(lastOffer(false) ?? s.asked)}</b></span>
              <span className="text-sm">Us <b className="text-xl text-sky-700 tabular-nums">{money(lastOffer(true))}</b></span>
            </span>
          </div>
          <PriceTrack role="buyer" plan={{ ...data.plan, ladder: [], comps: nearComps }} offers={offers} />
        </div>
      )}

      {/* Main stage */}
      <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr_340px] gap-5">
        <Phone title={data.counterparty} subtitle="Seller · group text with Spencer's AI assistant" typing={next?.kind === "seller"}>
          {visible.map((b, i) =>
            b.kind === "seller" ? <Bubble key={i} side="left" tone="slate" ts={b.ts}>{b.text}</Bubble>
            : b.kind === "us" ? <Bubble key={i} side="right" tone={b.by === "claude" ? "blue" : "violet"} label={b.by === "claude" ? "Claude's move, sent by Fo" : "Fo, on its own"} ts={b.ts}>{b.text}</Bubble>
            : null,
          )}
        </Phone>

        <div className="relative flex min-h-0 flex-col gap-3">
          {/* Intro: the comps Claude found */}
          {data.plan && (shown <= intro || thoughts.length === 0) && (
            <div className="animate-event-in rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Search className="h-4 w-4 text-sky-600" /> Claude researched the market before the first text</div>
              <p className="mb-3 text-sm leading-relaxed text-slate-600">{data.plan.marketRead.split(/(?<=\.)\s/).slice(0, 2).join(" ")}</p>
              <div className="grid grid-cols-2 gap-2">
                {data.plan.comps.slice(0, 8).map((c, i) => (
                  <div key={i} className="animate-event-in flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs" style={{ animationDelay: `${i * 120}ms` }}>
                    <span className="truncate text-slate-600">{c.label}</span>
                    <span className="font-semibold tabular-nums">{money(c.price)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                <Lock className="h-3 w-3" /> Spencer's max stays private. Plan: open {money(data.plan.prices.open)}, aim for {money(data.plan.prices.target)}.
              </div>
            </div>
          )}
          {/* Claude's reasoning, newest first */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            {[...thoughts].reverse().slice(0, 4).map((t, i) => (
              <div key={t.ts + t.title} className={cn("animate-event-in rounded-2xl border bg-white p-4 shadow-sm transition-opacity", i === 0 ? "border-sky-300 ring-2 ring-sky-100" : "border-slate-200 opacity-60")}>
                <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                  <Brain className="h-4 w-4 text-sky-600" /> {t.title}
                  <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-emerald-700"><ShieldCheck className="h-3 w-3" /> privacy-checked</span>
                </div>
                <p className="text-[13px] leading-relaxed text-slate-600">{t.text}</p>
              </div>
            ))}
          </div>

          {/* Summary */}
          {done && (
            <div className="animate-event-in absolute inset-0 z-10 flex items-center justify-center">
              <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-7 shadow-2xl">
                <div className="text-xs font-semibold uppercase tracking-widest text-emerald-700">Deal done</div>
                <div className="mt-1 text-4xl font-semibold tracking-tight">
                  {money(s.agreed)} <span className="text-lg font-normal text-slate-400">asked {money(s.asked)}</span>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <Stat icon={<BellRing className="h-4 w-4" />} big={`${s.ownerAsks}×`} label="Spencer was needed" />
                  <Stat icon={<Brain className="h-4 w-4" />} big={String(s.messages)} label="texts handled for him" />
                  <Stat icon={<Search className="h-4 w-4" />} big={String(data.plan?.comps.length ?? 0)} label="comps researched first" />
                  <Stat icon={<ShieldCheck className="h-4 w-4" />} big={String(s.checked)} label="messages privacy-checked" />
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <CalendarCheck className="h-4 w-4" /> Pickup is on Spencer's calendar{s.minutes ? ` · ${s.minutes} minutes start to finish` : ""}
                </div>
              </div>
            </div>
          )}
        </div>

        <Phone
          title="Spencer"
          subtitle={ownerHot ? "Needs you" : "Quiet until it needs you"}
          glow={ownerHot}
          typing={next?.kind === "owner-in"}
          footer={calendar && (
            <div className="animate-event-in m-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-sky-900"><CalendarCheck className="h-4 w-4" /> Added to calendar</div>
              <div className="text-sky-900/80">{calendar.text}</div>
            </div>
          )}
        >
          {visible.map((b, i) =>
            b.kind === "owner-in" ? (
              <Bubble key={i} side="left" tone="slate" ts={b.ts} label={<span className="font-semibold text-amber-600">{b.why}</span>}>{b.text}</Bubble>
            ) : b.kind === "owner-out" ? (
              <Bubble key={i} side="right" tone="green" ts={b.ts}>{b.text}</Bubble>
            ) : null,
          )}
          {!visible.some((b) => b.kind === "owner-in") && (
            <div className="mt-16 text-center text-xs text-slate-400">No texts yet. Claude handles the back and forth and only checks in for decisions.</div>
          )}
        </Phone>
      </div>

      {/* Controls (hidden for recording) */}
      {!recording && (
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <button className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white" onClick={() => { if (done) setShown(0); setPlaying((p) => !p); }}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} {playing ? "Pause" : done ? "Replay" : "Play"}
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5" onClick={() => setShown((n) => Math.min(total, n + 1))}><SkipForward className="h-4 w-4" /> Step</button>
          <button className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5" onClick={() => { setShown(0); setPlaying(false); setStarted(false); }}><RotateCcw className="h-4 w-4" /> Reset</button>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-sky-600 transition-all" style={{ width: `${total ? (shown / total) * 100 : 0}%` }} /></div>
          <span className="text-xs text-slate-500">Speed {speed}× · add ?autoplay=1&chrome=0 to record</span>
          <Link to={`/deals/${id}`} className="text-xs text-slate-500 underline">Back to deal</Link>
        </div>
      )}
      {recording && <div className="shrink-0 text-center text-[11px] text-slate-400">Replay of a live run: real texts and calendar via Fo. A teammate played the seller.</div>}
    </div>
  );
}

function Stat({ icon, big, label }: { icon: ReactNode; big: string; label: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="flex items-center gap-1.5 text-slate-500">{icon}<span className="text-xs">{label}</span></div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{big}</div>
    </div>
  );
}
