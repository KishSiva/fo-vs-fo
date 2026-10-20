import { BellRing, Crown, ExternalLink, Film, MessageSquareText, Users } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { PriceTrack } from "@/components/PriceTrack";
import { QueryState, StageBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHealth, useHunt } from "@/lib/api";
import type { HuntSeller } from "@/lib/types";
import { cn, money, relative } from "@/lib/utils";

function SellerCard({ s, winner, best }: { s: HuntSeller; winner: boolean; best: boolean }) {
  const lost = s.stage === "ABANDONED";
  return (
    <Card className={cn("flex flex-col rounded-2xl transition-opacity", winner && "border-emerald-400 ring-2 ring-emerald-100", lost && "opacity-55")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {winner && <Crown className="h-4 w-4 text-emerald-600" />}
          {s.counterparty.name}
        </CardTitle>
        <StageBadge stage={s.stage} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-slate-50 p-2.5">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">They're at</div>
            <div className="flex items-center gap-1.5 text-xl font-semibold tabular-nums">
              {money(s.theirs)} {best && !lost && <Badge variant="green">best</Badge>}
            </div>
          </div>
          <div className="rounded-lg bg-sky-50 p-2.5">
            <div className="text-[11px] uppercase tracking-wide text-sky-700">We offered</div>
            <div className="text-xl font-semibold tabular-nums text-sky-800">{money(s.ours)}</div>
          </div>
        </div>
        {s.pendingApproval && (
          <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800">
            <BellRing className="h-3.5 w-3.5" /> Waiting on your YES
          </div>
        )}
        {s.lastMessage && (
          <div className="flex-1 text-sm">
            <div className="mb-1 flex items-center gap-1 text-[11px] text-slate-400">
              <MessageSquareText className="h-3 w-3" /> {s.lastMessage.from === "them" ? s.counterparty.name : "Your assistant"} · {relative(s.lastMessage.ts)}
            </div>
            <p className={cn("rounded-xl px-3 py-2", s.lastMessage.from === "them" ? "bg-slate-100" : "bg-sky-600 text-white")}>
              <span className="line-clamp-3">{s.lastMessage.text}</span>
            </p>
          </div>
        )}
        <div className="flex gap-3 border-t pt-2 text-xs">
          <Link to={`/deals/${s.id}`} className="flex items-center gap-1 text-slate-600 hover:text-slate-900"><ExternalLink className="h-3.5 w-3.5" /> Open</Link>
          <Link to={`/deals/${s.id}/replay`} className="flex items-center gap-1 text-slate-600 hover:text-slate-900"><Film className="h-3.5 w-3.5" /> Replay</Link>
        </div>
      </CardContent>
    </Card>
  );
}

export function HuntPage() {
  const { id = "" } = useParams();
  const q = useHunt(id);
  const health = useHealth();
  return (
    <QueryState isPending={q.isPending} error={q.error}>
      {q.data && ((d) => {
        const live = d.sellers.filter((s) => s.stage !== "ABANDONED");
        const prices = live.map((s) => s.theirs).filter((n): n is number => n != null);
        const best = prices.length ? Math.min(...prices) : null;
        const winner = d.sellers.find((s) => s.id === d.hunt.winnerDealId);
        return (
          <div className="mx-auto max-w-6xl space-y-5">
            <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-sky-900 p-6 text-white shadow-lg">
              <div className="flex items-center gap-2 text-sm font-medium text-sky-300"><Users className="h-4 w-4" /> Search · {d.sellers.length} sellers</div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{d.hunt.item.split(/[,.(]/)[0]}</h1>
              <p className="mt-2 text-sm text-slate-300">
                {winner
                  ? `Done: ${winner.counterparty.name} won. The other sellers were thanked and closed.`
                  : `Your assistant is negotiating with ${live.length} sellers at once, using real offers as leverage. Only one wins, and only after your YES.`}
              </p>
            </div>
            {d.plan && (
              <Card className="rounded-2xl">
                <CardHeader>
                  <CardTitle>Where every seller stands</CardTitle>
                  <span className="text-xs text-slate-500">Dark ticks: sellers' latest prices · blue: our offers</span>
                </CardHeader>
                <CardContent>
                  <PriceTrack
                    role={health.data?.role ?? "buyer"}
                    plan={{ ...d.plan, ladder: [] }}
                    offers={live.flatMap((s) => [
                      ...(s.theirs != null ? [{ amount: s.theirs, ours: false }] : []),
                      ...(s.ours != null ? [{ amount: s.ours, ours: true }] : []),
                    ])}
                  />
                </CardContent>
              </Card>
            )}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {d.sellers.map((s) => <SellerCard key={s.id} s={s} winner={s.id === d.hunt.winnerDealId} best={s.theirs != null && s.theirs === best} />)}
            </div>
          </div>
        );
      })(q.data)}
    </QueryState>
  );
}
