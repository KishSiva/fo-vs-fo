import { Check, Fingerprint, X } from "lucide-react";
import { Link } from "react-router-dom";
import { TierBadge } from "@/components/EventItem";
import { Empty, QueryState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useDecideApproval, usePendingApprovals } from "@/lib/api";
import type { Approval } from "@/lib/types";
import { cn, relative } from "@/lib/utils";

/** Flatten nested payload into dotted key paths for a readable key/value view. */
function flatten(value: unknown, prefix = ""): [string, string][] {
  if (value === null || typeof value !== "object") return [[prefix || "value", JSON.stringify(value)]];
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  if (!entries.length) return [[prefix || "value", Array.isArray(value) ? "[]" : "{}"]];
  return entries.flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v !== null && typeof v === "object" ? flatten(v, key) : [[key, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]];
  });
}

const isMoneyKey = (k: string) => /amount|price|total|payment|usd|\$/i.test(k);

function PayloadView({ payload }: { payload: unknown }) {
  const rows = flatten(payload);
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 font-mono text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className={cn("flex gap-3 border-b border-slate-100 px-3 py-1 last:border-0", isMoneyKey(k) ? "bg-red-50" : "bg-emerald-50/40")}>
          <span className="select-none text-emerald-600">+</span>
          <span className="w-48 shrink-0 truncate text-slate-500" title={k}>
            {k}
          </span>
          <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", isMoneyKey(k) ? "font-bold text-red-700" : "text-slate-900")}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function ApprovalCard({ a }: { a: Approval }) {
  const decide = useDecideApproval();
  const busy = decide.isPending && decide.variables?.id === a.id;
  return (
    <Card className={cn("overflow-hidden", a.tier >= 3 && "border-red-300 ring-1 ring-red-200")}>
      <div className={cn("h-1", a.tier >= 3 ? "bg-red-500" : a.tier === 2 ? "bg-amber-500" : "bg-slate-300")} />
      <div className="flex flex-wrap items-start gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={a.tier} />
            <span className="text-xs text-slate-500">requested {relative(a.createdAt)}</span>
            <Link to={`/deals/${a.dealId}`} className="text-xs text-sky-700 underline">
              view deal
            </Link>
          </div>
          <div className="text-base font-medium">{a.summary}</div>
          <PayloadView payload={a.payload} />
          <div className="flex items-center gap-1 text-[11px] text-slate-500" title="The proxy executes exactly this payload; any change invalidates the approval.">
            <Fingerprint className="h-3 w-3" /> payload hash <code className="font-mono">{a.payloadHash.slice(0, 16)}</code>
          </div>
          {decide.isError && <div className="text-xs text-red-600">{decide.error.message}</div>}
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="success" size="lg" disabled={busy} onClick={() => decide.mutate({ id: a.id, decision: "approved" })}>
            <Check className="h-4 w-4" /> Approve
          </Button>
          <Button variant="outline" size="lg" disabled={busy} onClick={() => decide.mutate({ id: a.id, decision: "denied" })} className="text-red-700">
            <X className="h-4 w-4" /> Deny
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function ApprovalsPage() {
  const { data, isPending, error } = usePendingApprovals();
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Pending approvals</CardTitle>
          <span className="text-xs text-slate-500">Tier 1 = info · Tier 2 = commitments · Tier 3 = money</span>
        </CardHeader>
        {!isPending && !error && !data?.length && <Empty>Nothing waiting on you. The proxy will ask here before any gated action.</Empty>}
      </Card>
      <QueryState isPending={isPending} error={error}>
        {[...(data ?? [])]
          .sort((x, y) => y.tier - x.tier || x.createdAt.localeCompare(y.createdAt))
          .map((a) => (
            <ApprovalCard key={a.id} a={a} />
          ))}
      </QueryState>
    </div>
  );
}
