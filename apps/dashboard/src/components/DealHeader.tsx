import { Bot, Building2, Lock, User } from "lucide-react";
import type { Deal, DealDetail, Stage } from "@/lib/types";
import { money } from "@/lib/utils";
import { StageBadge, StageStrip, StatusBadge } from "./common";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

const KIND_ICON = { fo: Bot, human: User, business: Building2 };

export function CounterpartyLine({ deal }: { deal: Deal }) {
  const cp = deal.counterparty;
  const Icon = KIND_ICON[cp.kind] ?? User;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
      <Badge variant="outline" className="capitalize">{deal.role}</Badge>
      <span>with</span>
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium text-slate-700">{cp.name}</span>
      <span>({cp.kind === "fo" ? "Fo agent" : cp.kind})</span>
      {cp.phone && <span className="font-mono">{cp.phone}</span>}
    </div>
  );
}

export function DealHeader({ deal, stage }: { deal: DealDetail; stage: Stage }) {
  const m = deal.mandate;
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{deal.item}</h1>
            <StageBadge stage={stage} />
            <StatusBadge status={deal.status} />
          </div>
          <div className="mt-1">
            <CounterpartyLine deal={deal} />
          </div>
        </div>
        {m && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="outline">opening {money(m.openingOffer)}</Badge>
            <Badge variant="outline">max step {money(m.maxConcessionPerRound)}/round</Badge>
            {m.dealbreakers?.length > 0 && <Badge variant="outline" title={m.dealbreakers.join("\n")}>{m.dealbreakers.length} dealbreakers</Badge>}
            {m.neverShare?.length > 0 && (
              <Badge variant="red" title={`Never shared:\n${m.neverShare.join("\n")}`}>
                {m.neverShare.length} never-share rules
              </Badge>
            )}
            <Badge variant="dark" title="Floor / ceiling / walk-away are redacted server-side and never sent to the dashboard">
              <Lock className="h-3 w-3" /> limits redacted
            </Badge>
          </div>
        )}
      </div>
      <div className="mt-4">
        <StageStrip stage={stage} />
      </div>
    </Card>
  );
}
