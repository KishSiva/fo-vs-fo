import { CircleCheck, CircleX, ShieldCheck, ShieldAlert } from "lucide-react";
import { Empty, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useScorecard } from "@/lib/api";
import type { ScoreRow } from "@/lib/types";
import { cn, dateTime, money, pct } from "@/lib/utils";

const Bool = ({ ok }: { ok: boolean }) =>
  ok ? <CircleCheck className="mx-auto h-4 w-4 text-emerald-600" aria-label="pass" /> : <CircleX className="mx-auto h-4 w-4 text-red-600" aria-label="fail" />;

const OUTCOME = { closed: "green", abandoned: "default", escalated: "amber", timeout: "red" } as const;

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <Card className={cn("p-4", tone === "good" && "border-emerald-300 bg-emerald-50", tone === "bad" && "border-red-300 bg-red-50")}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "good" && "text-emerald-700", tone === "bad" && "text-red-700")}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </Card>
  );
}

const CHECKS: { key: keyof ScoreRow; label: string }[] = [
  { key: "mandateOk", label: "Mandate" },
  { key: "disclosureOk", label: "Disclosure" },
  { key: "approvalsOk", label: "Approvals" },
  { key: "commitmentsTracked", label: "Commitments" },
];

export function ScorecardPage() {
  const { data, isPending, error } = useScorecard();
  const rows = data?.rows ?? [];
  const leaks = rows.reduce((a, r) => a + r.leaks, 0);
  const closed = rows.filter((r) => r.outcome === "closed").length;
  return (
    <QueryState isPending={isPending} error={error}>
      {!rows.length ? (
        <Card>
          <Empty>No eval runs yet. Run the scorecard harness to populate this page.</Empty>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
            <Stat label="Total runs" value={String(rows.length)} sub={data?.generatedAt ? `generated ${dateTime(data.generatedAt)}` : undefined} />
            <Stat label="Leaks" value={String(leaks)} sub={leaks === 0 ? "no private data leaked" : "private data leaked!"} tone={leaks === 0 ? "good" : "bad"} />
            <Stat label="Closed" value={pct(closed, rows.length)} sub={`${closed}/${rows.length}`} />
            {CHECKS.map((c) => {
              const n = rows.filter((r) => r[c.key]).length;
              return <Stat key={c.key} label={c.label} value={pct(n, rows.length)} sub={`${n}/${rows.length} pass`} tone={n === rows.length ? "good" : undefined} />;
            })}
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    {["Persona", "Role", "Seed", "Outcome", "Price", "Leaks", ...CHECKS.map((c) => c.label), "Steps", "Duration"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{r.persona}</td>
                      <td className="px-3 py-2 capitalize">{r.role}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.seed}</td>
                      <td className="px-3 py-2">
                        <Badge variant={OUTCOME[r.outcome] ?? "default"}>{r.outcome}</Badge>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{money(r.price)}</td>
                      <td className="px-3 py-2">
                        <span className={cn("inline-flex items-center gap-1 font-semibold tabular-nums", r.leaks ? "text-red-700" : "text-emerald-700")}>
                          {r.leaks ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                          {r.leaks}
                        </span>
                      </td>
                      {CHECKS.map((c) => (
                        <td key={c.key} className="px-3 py-2 text-center">
                          <Bool ok={Boolean(r[c.key])} />
                        </td>
                      ))}
                      <td className="px-3 py-2 tabular-nums">{r.steps}</td>
                      <td className="px-3 py-2 tabular-nums">{r.durationSec.toFixed(0)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </QueryState>
  );
}
