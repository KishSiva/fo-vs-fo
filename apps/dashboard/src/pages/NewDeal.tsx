import { AlertTriangle, Lock, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { request } from "@/lib/api";
import { PROXIES, useProxy } from "@/lib/proxy";
import type { ChannelPref, FullMandate, Health, ParsedScenario } from "@/lib/types";
import { cn, money } from "@/lib/utils";

const EXAMPLE =
  "Ryan is selling a 2019 Trek Domane road bike, size 56, paid $2,400, recently tuned up, small scratch on the top tube. " +
  "He'd like $1,300 but will go as low as $950, and won't ship it. Muhammed wants it for weekend rides, will pay up to $1,100, " +
  "and needs to pick it up by Saturday. Ryan's address is 1420 Valencia St; Muhammed pays by Zelle.";

const CHANNELS: { value: ChannelPref; label: string }[] = [
  { value: "call", label: "Call only" },
  { value: "text", label: "Text only" },
  { value: "auto", label: "Let them choose" },
];

const newId = () => `PD-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

function Side({ title, name, m }: { title: string; name: string; m: FullMandate }) {
  const seller = title === "Seller";
  const row = (k: ReactNode, v: ReactNode) => (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-slate-500">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
  return (
    <div className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">{name}</span>
        <Badge variant="outline">{title.toLowerCase()}</Badge>
      </div>
      {row("Opens at", money(m.openingOffer))}
      {row(
        <span className="flex items-center gap-1">
          <Lock className="h-3 w-3" /> {seller ? "Lowest price" : "Highest price"}
        </span>,
        money(m.floorOrCeiling),
      )}
      {row("Max move per round", money(m.maxConcessionPerRound))}
      {row(<span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Walks away after</span>, `${m.walkAwayAt} rounds`)}
      {row("Dealbreakers", m.dealbreakers.join("; ") || "none")}
      {row("May share", m.allowedShare.join(", ") || "nothing extra")}
      {row(
        <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Private facts</span>,
        Object.entries(m.secrets).map(([k, v]) => `${k}: ${v}`).join("; ") || "none",
      )}
    </div>
  );
}

export function NewDealPage() {
  const { proxy } = useProxy();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<ChannelPref>("call");
  const [parsed, setParsed] = useState<ParsedScenario | null>(null);
  const [busy, setBusy] = useState<"parse" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parse = async () => {
    setBusy("parse");
    setError(null);
    setParsed(null);
    try {
      setParsed(await request<ParsedScenario>(proxy.url, "/api/scenarios/parse", { method: "POST", body: JSON.stringify({ text }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Each proxy gets only its own side's mandate.
  const create = async () => {
    if (!parsed) return;
    setBusy("create");
    setError(null);
    const id = newId();
    const done: string[] = [];
    try {
      const roles = await Promise.all(PROXIES.map((p) => request<Health>(p.url, "/api/health")));
      for (const [i, p] of PROXIES.entries()) {
        const role = roles[i].role;
        await request(p.url, "/api/deals", {
          method: "POST",
          body: JSON.stringify({ id, item: parsed.item, mandate: parsed[role], channelPref: channel, start: true }),
        });
        done.push(roles[i].owner);
      }
      navigate(`/deals/${id}`);
    } catch (e) {
      const partial = done.length ? ` Created on ${done.join(", ")} only; abandon ${id} there before retrying.` : "";
      setError(`${(e as Error).message}${partial}`);
    } finally {
      setBusy(null);
    }
  };

  // The proxies reject an opening past that side's own limit; a scenario with no possible deal is allowed (they should walk away).
  const blocked = parsed?.warnings.some((w) => /\bopens at\b/i.test(w));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>New deal from a scenario</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">
            Describe the deal in your own words: the item, what each side wants, their limits, dealbreakers, and anything they must keep private.
            Anything you leave out gets a sensible default, which you'll see before creating.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder={EXAMPLE}
            className="w-full rounded-md border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setText(EXAMPLE)} disabled={busy !== null}>
              Use example
            </Button>
            <Button size="sm" onClick={parse} disabled={!text.trim() || busy !== null}>
              <Sparkles className="h-3.5 w-3.5" /> {busy === "parse" ? "Reading…" : "Read scenario"}
            </Button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </CardContent>
      </Card>

      {parsed && (
        <Card>
          <CardHeader>
            <CardTitle>Check before creating</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium">{parsed.summary}</p>
            <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Item (both agents see this)</div>
              {parsed.item}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Side title="Seller" name={parsed.names.seller} m={parsed.seller} />
              <Side title="Buyer" name={parsed.names.buyer} m={parsed.buyer} />
            </div>
            <p className="flex items-center gap-1 text-xs text-slate-500">
              <Lock className="h-3 w-3" /> Locked values go only to that side's agent and are hidden on the dashboard once the deal exists.
            </p>
            {parsed.assumptions.length > 0 && (
              <div className="text-sm">
                <div className="text-xs font-semibold uppercase text-slate-500">Filled in for you</div>
                <ul className="ml-4 list-disc text-slate-700">{parsed.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
              </div>
            )}
            {parsed.warnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                {parsed.warnings.map((w) => (
                  <div key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}</div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="text-xs text-slate-500">Channel</span>
              {CHANNELS.map((c) => (
                <Button key={c.value} size="sm" variant={channel === c.value ? "default" : "outline"} onClick={() => setChannel(c.value)}>
                  {c.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={create} disabled={busy !== null || blocked} className={cn(blocked && "opacity-50")}>
                {busy === "create" ? "Creating…" : "Create deal and start"}
              </Button>
              <span className="text-xs text-slate-500">
                Starting places real {channel === "text" ? "texts" : channel === "call" ? "calls" : "calls or texts"} through both Fo accounts.
              </span>
            </div>
            {blocked && <div className="text-xs text-red-600">Fix the scenario wording so the warnings above go away, then read it again.</div>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
