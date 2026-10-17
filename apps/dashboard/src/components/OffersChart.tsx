import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Offer } from "@/lib/types";
import { money, time } from "@/lib/utils";
import { Empty } from "./common";

// Categorical slots 1 & 2 of the reference palette (validated light-mode pair).
const SELF = "#2a78d6";
const THEM = "#eb6834";

export function OffersChart({ offers, openingOffer }: { offers: Offer[]; openingOffer?: number }) {
  if (!offers.length) return <Empty>No offers yet.</Empty>;
  const pts = (from: Offer["from"]) =>
    offers.filter((o) => o.from === from).map((o) => ({ t: new Date(o.ts).getTime(), amount: o.amount, terms: o.terms }));
  const self = pts("self");
  const them = pts("counterparty");
  const last = offers.at(-1)!;
  const dot = (color: string) => ({ r: 4, fill: color, stroke: "#fff", strokeWidth: 2 });

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-xs text-slate-500">
        <span>
          {offers.length} offer{offers.length === 1 ? "" : "s"}
        </span>
        <span>
          latest <span className="text-base font-semibold tabular-nums text-slate-900">{money(last.amount)}</span> (
          {last.from === "self" ? "us" : "them"})
        </span>
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <LineChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            tick={{ fontSize: 11, fill: "#64748b" }}
            stroke="#cbd5e1"
            allowDuplicatedCategory={false}
          />
          <YAxis
            dataKey="amount"
            tickFormatter={(v) => `$${v}`}
            tick={{ fontSize: 11, fill: "#64748b" }}
            stroke="#cbd5e1"
            width={56}
            domain={[(min: number) => Math.floor((min * 0.95) / 10) * 10, (max: number) => Math.ceil((max * 1.05) / 10) * 10]}
          />
          <Tooltip
            formatter={(v) => money(Number(v))}
            labelFormatter={(t) => time(new Date(Number(t)).toISOString())}
            contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: "#e2e8f0" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
          {openingOffer != null && (
            <ReferenceLine y={openingOffer} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: "our opening", fontSize: 10, fill: "#64748b", position: "insideTopRight" }} />
          )}
          <Line data={self} dataKey="amount" name="Us (self)" type="stepAfter" stroke={SELF} strokeWidth={2} dot={dot(SELF)} activeDot={{ r: 6 }} isAnimationActive={false} />
          <Line data={them} dataKey="amount" name="Counterparty" type="stepAfter" stroke={THEM} strokeWidth={2} dot={dot(THEM)} activeDot={{ r: 6 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
