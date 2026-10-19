import { Lock } from "lucide-react";
import type { CompKind, DealPlan, Role } from "@/lib/types";
import { cn, money } from "@/lib/utils";

const COMP_COLOR: Record<CompKind, string> = {
  new: "bg-slate-400",
  refurbished: "bg-violet-500",
  used: "bg-sky-500",
  sold: "bg-emerald-600",
  listing: "bg-sky-300",
};

interface Marker { label: string; value: number; tone: string; secret?: boolean }

/**
 * One horizontal price line: where the comps sit, the owner's zone (open → happy → limit), the counter ladder and
 * the other side's asking price. New-retail comps are left off the scale (they'd squash everything else) but listed.
 */
export function PriceTrack({ role, plan, offers = [] }: { role: Role; plan: Pick<DealPlan, "prices" | "askingPrice" | "comps" | "ladder">; offers?: { amount: number; ours: boolean }[] }) {
  const { open, target, happy, limit } = plan.prices;
  const onScale = plan.comps.filter((c) => c.kind !== "new" && c.price > 0);
  const values = [open, target, happy, limit, ...(plan.askingPrice ? [plan.askingPrice] : []), ...onScale.map((c) => c.price), ...plan.ladder.map((s) => s.amount), ...offers.map((o) => o.amount)].filter((v) => v > 0);
  if (!values.length) return null;
  const lo = Math.min(...values) * 0.9;
  const hi = Math.max(...values) * 1.06;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  const span = (a: number, b: number) => ({ left: pos(Math.min(a, b)), width: `calc(${pos(Math.max(a, b))} - ${pos(Math.min(a, b))})` });
  const buyer = role === "buyer";

  const markers: Marker[] = [
    { label: "Open", value: open, tone: "text-slate-600" },
    { label: "Target", value: target, tone: "text-emerald-700" },
    { label: "Happy", value: happy, tone: "text-emerald-700" },
    { label: buyer ? "Max" : "Min", value: limit, tone: "text-rose-700", secret: true },
    ...(plan.askingPrice ? [{ label: buyer ? "Their ask" : "Our ask", value: plan.askingPrice, tone: "text-slate-900" }] : []),
  ]
    .sort((a, b) => a.value - b.value)
    // Two markers at the same price share one label ("Max · Their ask").
    .reduce<Marker[]>((out, m) => {
      const same = out.find((o) => o.value === m.value);
      if (same) Object.assign(same, { label: `${same.label} · ${m.label}`, secret: same.secret || m.secret, tone: same.secret ? same.tone : m.tone });
      else out.push({ ...m });
      return out;
    }, []);
  // Put each label on the first row where it clears the previous label on that row.
  const rowEnds: number[] = [];
  const rows = markers.map((m) => {
    const x = ((m.value - lo) / (hi - lo)) * 100;
    let r = rowEnds.findIndex((end) => x - end >= 9);
    if (r === -1) r = rowEnds.length;
    rowEnds[r] = x;
    return r;
  });

  return (
    <div className="select-none">
      <div className="relative" style={{ height: 82 + Math.max(1, rowEnds.length) * 40 }}>
        {/* comps above the line */}
        {onScale.map((c, i) => (
          <a
            key={`${c.label}-${i}`}
            href={c.url || undefined}
            target="_blank"
            rel="noreferrer"
            title={`${c.label}: ${money(c.price)}`}
            className={cn("absolute top-3 h-3 w-3 -translate-x-1/2 rounded-full ring-2 ring-white transition-transform hover:scale-150", COMP_COLOR[c.kind])}
            style={{ left: pos(c.price), top: 8 + (i % 3) * 12 }}
          />
        ))}
        {/* the line and the owner's zones */}
        <div className="absolute inset-x-0 top-[58px] h-3 rounded-full bg-slate-100" />
        <div className="absolute top-[58px] h-3 rounded-l-full bg-emerald-300/80" style={span(open, happy)} title="Good zone" />
        <div className="absolute top-[58px] h-3 bg-amber-300/80" style={span(happy, limit)} title="Stretch zone (check with you)" />
        <div
          className="absolute top-[58px] h-3 rounded-r-full bg-[repeating-linear-gradient(45deg,#fecdd3_0,#fecdd3_4px,#fff1f2_4px,#fff1f2_8px)]"
          style={buyer ? { left: pos(limit), right: 0 } : { left: 0, width: pos(limit) }}
          title="Walk away"
        />
        {/* counter ladder */}
        {plan.ladder.map((s, i) => (
          <div
            key={i}
            title={`Counter ${i + 1}: ${money(s.amount)}, ${s.reason}`}
            className="absolute top-[52px] flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border-2 border-slate-900 bg-white text-[10px] font-bold"
            style={{ left: pos(s.amount) }}
          >
            {i + 1}
          </div>
        ))}
        {/* live offers (deal page) */}
        {offers.map((o, i) => (
          <div key={`o${i}`} className={cn("absolute top-[46px] h-9 w-1 -translate-x-1/2 rounded", o.ours ? "bg-sky-600" : "bg-slate-900")} style={{ left: pos(o.amount) }} title={`${o.ours ? "We" : "They"} offered ${money(o.amount)}`} />
        ))}
        {/* labelled markers below, staggered so neighbours don't collide */}
        {markers.map((m, i) => (
          <div key={m.label} className="absolute -translate-x-1/2 text-center" style={{ left: pos(m.value), top: 78 + rows[i] * 40 }}>
            <div className={cn("flex items-center justify-center gap-1 whitespace-nowrap text-[11px] font-medium uppercase tracking-wide", m.tone)}>
              {m.secret && <Lock className="h-3 w-3" />}
              {m.label}
            </div>
            <div className={cn("text-sm font-semibold tabular-nums", m.tone)}>{money(m.value)}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {(Object.keys(COMP_COLOR) as CompKind[]).filter((k) => plan.comps.some((c) => c.kind === k)).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-full", COMP_COLOR[k])} /> {k}
            {k === "new" && ` (${plan.comps.filter((c) => c.kind === "new").map((c) => money(c.price)).join(", ")}, off scale)`}
          </span>
        ))}
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-emerald-300" /> good</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-amber-300" /> check with you</span>
        <span className="flex items-center gap-1.5"><span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-slate-900 text-[8px] font-bold">1</span> counter offers</span>
      </div>
    </div>
  );
}
