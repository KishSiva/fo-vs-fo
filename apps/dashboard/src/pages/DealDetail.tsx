import { CircleCheck, CircleX, Film, Hand, Pause, Play, RefreshCw, Users, Zap } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { DealHeader } from "@/components/DealHeader";
import { ExpectedObserved } from "@/components/EventItem";
import { OffersChart } from "@/components/OffersChart";
import { Rehearsal } from "@/components/Rehearsal";
import { Timeline } from "@/components/Timeline";
import { Empty, QueryState, StageBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCommitments, useDeal, useDealCommand, useEvents, useHealth, useOffers, useSetChannel, useVerifications } from "@/lib/api";
import { useReplay } from "@/lib/replay";
import type { ChannelPref, Command, Commitment, DealDetail, Stage } from "@/lib/types";
import { cn, relative, time } from "@/lib/utils";

function Commands({ deal }: { deal: DealDetail }) {
  const cmd = useDealCommand(deal.id);
  const done = deal.status === "closed" || deal.status === "abandoned";
  const run = (t: Command) => {
    if (t === "abandon" && !confirm("Abandon this deal? The proxy will stop negotiating.")) return;
    cmd.mutate(t);
  };
  const btn = (t: Command, Icon: typeof Zap, label: string, disabled: boolean, variant: "outline" | "destructive" = "outline") => (
    <Button variant={variant} size="sm" disabled={disabled || cmd.isPending} onClick={() => run(t)}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </Button>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Owner controls</CardTitle>
        {cmd.isSuccess && <span className="text-xs text-emerald-600">sent “{cmd.variables}”</span>}
        {cmd.isError && <span className="text-xs text-red-600">{cmd.error.message}</span>}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {btn("check", RefreshCw, "Check Fo now", done)}
        {btn("nudge", Zap, "Nudge", done || deal.status === "paused")}
        {btn("pause", Pause, "Pause", done || deal.status === "paused")}
        {btn("resume", Play, "Resume", deal.status !== "paused")}
        {btn("abandon", Hand, "Abandon", done, "destructive")}
        <Link to={`/deals/${deal.id}/replay`} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium hover:bg-slate-100">
          <Film className="h-3.5 w-3.5" /> Replay
        </Link>
      </CardContent>
      <ChannelPicker deal={deal} disabled={done} />
    </Card>
  );
}

const CHANNELS: { value: ChannelPref; label: string; title: string }[] = [
  { value: "auto", label: "Let them choose", title: "The proxy picks text or a call for each contact" },
  { value: "text", label: "Text only", title: "Every outbound contact is a text" },
  { value: "call", label: "Call only", title: "Every outbound contact is a phone call" },
];

function ChannelPicker({ deal, disabled }: { deal: DealDetail; disabled: boolean }) {
  const set = useSetChannel(deal.id);
  return (
    <CardContent className="flex flex-wrap items-center gap-2 border-t pt-3">
      <span className="text-xs text-slate-500">Channel</span>
      {CHANNELS.map((c) => (
        <Button
          key={c.value}
          size="sm"
          title={c.title}
          variant={deal.channelPref === c.value ? "default" : "outline"}
          disabled={disabled || set.isPending}
          onClick={() => set.mutate(c.value)}
        >
          {c.label}
        </Button>
      ))}
      {set.isError && <span className="text-xs text-red-600">{set.error.message}</span>}
    </CardContent>
  );
}

const COMMIT_BADGE = { open: "amber", kept: "green", broken: "red" } as const;

function Commitments({ items }: { items: Commitment[] }) {
  const sorted = [...items].sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || a.dueAt.localeCompare(b.dueAt));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Commitments</CardTitle>
        <span className="text-xs text-slate-500">{items.filter((c) => c.status === "open").length} open</span>
      </CardHeader>
      {!items.length ? (
        <Empty>No commitments tracked yet.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {sorted.map((c) => {
            const overdue = c.status === "open" && new Date(c.dueAt) < new Date();
            return (
              <li key={c.id} className="flex items-start gap-2 px-4 py-2">
                <Badge variant={COMMIT_BADGE[c.status]}>{c.status}</Badge>
                <div className="min-w-0 flex-1">
                  <div>
                    <span className="font-medium">{c.who}</span>: {c.what}
                  </div>
                  <div className={cn("text-xs", overdue ? "font-semibold text-red-600" : "text-slate-500")}>
                    due {relative(c.dueAt)}
                    {overdue && " · overdue"}
                  </div>
                  {c.evidence && <div className="text-xs text-slate-500">evidence: {c.evidence}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function DealDetailPage() {
  const { id = "" } = useParams();
  const deal = useDeal(id);
  const events = useEvents(id);
  const offers = useOffers(id);
  const commitments = useCommitments(id);
  const verifications = useVerifications(id);
  const replay = useReplay(events.data ?? []);
  const health = useHealth();

  // During replay, the right column + header follow the replay cursor.
  const upTo = <T extends { ts: string }>(xs: T[] = []) => (replay.cursorTs == null ? xs : xs.filter((x) => x.ts <= replay.cursorTs!));
  let stage: Stage | undefined = deal.data?.stage;
  if (replay.active) {
    const firstT = events.data?.find((e) => e.kind === "Transition");
    const lastShown = replay.events.filter((e) => e.kind === "Transition").at(-1);
    stage = (lastShown?.data?.to ?? firstT?.data?.from ?? "NEGOTIATING") as Stage;
  }
  const verifs = upTo(verifications.data);

  return (
    <QueryState isPending={deal.isPending} error={deal.data ? null : deal.error}>
      {deal.data && (
        <>
          {deal.error && (
            <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Proxy offline — showing last known data, retrying every 3s.
            </div>
          )}
          <DealHeader deal={deal.data} stage={stage ?? deal.data.stage} />
          {deal.data.huntId && (
            <Link to={`/hunts/${deal.data.huntId}`} className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 hover:bg-sky-100">
              <Users className="h-4 w-4" /> One of several sellers in a search. See where they all stand →
            </Link>
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            <Timeline allEvents={events.data ?? []} replay={replay} />
            <div className="flex flex-col gap-4">
              <Rehearsal deal={deal.data} health={health.data} />
              <Card>
                <CardHeader>
                  <CardTitle>Offers</CardTitle>
                </CardHeader>
                <CardContent>
                  <OffersChart offers={upTo(offers.data)} openingOffer={deal.data.mandate?.openingOffer} />
                </CardContent>
              </Card>
              <Commitments items={commitments.data ?? []} />
              <Card>
                <CardHeader>
                  <CardTitle>Verifications</CardTitle>
                  <span className="text-xs text-slate-500">
                    {verifs.filter((v) => v.passed).length}/{verifs.length} passed
                  </span>
                </CardHeader>
                {!verifs.length ? (
                  <Empty>No verifications yet.</Empty>
                ) : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {verifs.map((v) => (
                      <li key={v.id} className="flex gap-2 px-4 py-2">
                        {v.passed ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <StageBadge stage={v.stage} />
                            <span className="text-xs text-slate-400">{time(v.ts)}</span>
                          </div>
                          <ExpectedObserved expected={v.expected} observed={v.observed} />
                          {v.evidence?.length > 0 && (
                            <div className="mt-1 text-xs text-slate-500">evidence: {v.evidence.join(", ")}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Commands deal={deal.data} />
            </div>
          </div>
        </>
      )}
    </QueryState>
  );
}
