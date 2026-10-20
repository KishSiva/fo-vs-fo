import { AlertTriangle, ArrowRight, Check, ExternalLink, Lock, MessageSquareText, Phone, RefreshCw, Search, ShieldCheck, ShoppingBag, Sparkles, Target, Users, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PriceTrack } from "@/components/PriceTrack";
import { request, useHealth } from "@/lib/api";
import { useProxy } from "@/lib/proxy";
import type { ChannelPref, DealPlan, ParsedListing, PlanResult, Role, Strategy } from "@/lib/types";
import { cn, money } from "@/lib/utils";

const EXAMPLES = [
  {
    name: "Office chair",
    listing:
      "Herman Miller Sayl chairs – asking price $350\n\nWe have Herman Miller Sayl chairs for sale at our office. We need to clear out space and are looking to sell each chair for $300. " +
      "There are currently 8 available. Perfect for filling an office space or home set up!",
    notes: "I want to buy one chair. I can pick up Tuesday or Wednesday between 4 and 6pm.",
  },
  {
    // The Impossible E-Bike (scenarios/the-impossible-ebike.md): price alone can't work; the furniture bundle can.
    name: "E-bike",
    listing:
      "FOR SALE: 2023 Rad Power RadCity 5 Plus e-bike (step-thru, grey), ~800 miles. Always stored indoors, new brake pads in August. " +
      "Charger included. $1,400. Pickup in the Mission, SF.",
    notes:
      "I just moved to SF for a new job in SoMa; first day is Monday 9am and I need the bike before then (bus 40 min, bike 18). " +
      "My studio is unfurnished: mattress on the floor, working at the kitchen counter. $950 is my absolute max (it's what's left in savings), " +
      "and I'll only go above $900 if a lock is included. I must get the charger. No car, but my friend Priya can lend her pickup " +
      "truck Saturday 10am-2pm only. I can pay cash or Venmo on pickup. If this falls through I take the bus.",
  },
];

const CHANNELS: { value: ChannelPref; label: string; icon: ReactNode }[] = [
  { value: "text", label: "Text", icon: <MessageSquareText className="h-3.5 w-3.5" /> },
  { value: "call", label: "Phone call", icon: <Phone className="h-3.5 w-3.5" /> },
  { value: "auto", label: "Agent picks", icon: <Sparkles className="h-3.5 w-3.5" /> },
];

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: "coach", label: "Claude coaches live", hint: "Claude reads every reply and decides each move. Best for tight haggling." },
  { value: "handoff", label: "Claude plans, Fo negotiates", hint: "The plan goes to Fo in one go. Fo runs the conversation; Claude watches and steps in." },
];

interface Seller { name: string; phone: string; listing: string }

const newId = () => `PD-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

const field = "field-sizing-content w-full rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-inner shadow-slate-100 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200";

/** Same checks the server runs, so the owner sees problems while editing. */
function planProblems(role: Role, p: DealPlan): string[] {
  const out: string[] = [];
  const { open, target, happy, limit } = p.prices;
  const up = role === "buyer" ? 1 : -1;
  if (![open, target, happy, limit].every((n) => Number.isFinite(n) && n > 0)) return ["Every price must be a positive number."];
  if ((target - open) * up < 0 || (happy - target) * up < 0 || (limit - happy) * up < 0)
    out.push(role === "buyer" ? "Prices should go open ≤ target ≤ happy ≤ max." : "Prices should go open ≥ target ≥ happy ≥ min.");
  if (!p.ladder.length) out.push("The counter ladder is empty.");
  p.ladder.forEach((s, n) => {
    const prev = n === 0 ? open : p.ladder[n - 1].amount;
    if ((s.amount - prev) * up < 0) out.push(`Counter ${n + 1} (${money(s.amount)}) moves backwards.`);
    if ((s.amount - limit) * up > 0) out.push(`Counter ${n + 1} (${money(s.amount)}) is past your ${role === "buyer" ? "max" : "min"}.`);
  });
  if (!/AI assistant/i.test(p.opener)) out.push("The opener must say it is an AI assistant.");
  return out;
}

/** Drop blank lines left over from editing. */
const clean = (p: DealPlan): DealPlan => {
  const t = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return {
    ...p, discovery: t(p.discovery), trades: t(p.trades), tactics: t(p.tactics), dealbreakers: t(p.dealbreakers),
    niceToHaves: t(p.niceToHaves), checkWithOwner: t(p.checkWithOwner),
    theirInterests: p.theirInterests.filter((x) => x.signal.trim()), ladder: p.ladder.filter((s) => s.amount > 0),
  };
};

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const steps = ["Listing and goals", "Game plan", "Start"];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {steps.map((s, i) => {
        const n = i + 1;
        const done = n < step;
        const on = n === step;
        return (
          <li key={s} className="flex items-center gap-2">
            <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold", done ? "bg-emerald-500 text-white" : on ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500")}>
              {done ? <Check className="h-3.5 w-3.5" /> : n}
            </span>
            <span className={cn("font-medium", on ? "text-slate-900" : "text-slate-500")}>{s}</span>
            {n < steps.length && <ArrowRight className="h-3.5 w-3.5 text-slate-300" />}
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, icon, children, className }: { title: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-slate-200 bg-white p-4", className)}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

/** One item per line; blank lines are kept while typing and dropped on save. */
function ListEdit({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  return (
    <textarea
      value={value.join("\n")}
      onChange={(e) => onChange(e.target.value.split("\n"))}
      rows={rows}
      placeholder={placeholder}
      className={cn(field, "p-2 leading-relaxed")}
    />
  );
}

function PriceInput({ label, value, onChange, secret, tone }: { label: string; value: number; onChange: (n: number) => void; secret?: boolean; tone: string }) {
  return (
    <label className="block">
      <span className={cn("flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide", tone)}>
        {secret && <Lock className="h-3 w-3" />}
        {label}
      </span>
      <div className="relative mt-1">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">$</span>
        <input type="number" min={0} value={value || ""} onChange={(e) => onChange(Number(e.target.value))} className={cn(field, "py-1.5 pl-6 text-base font-semibold tabular-nums")} />
      </div>
    </label>
  );
}

function PlanEditor({ role, plan, setPlan, owner }: { role: Role; plan: DealPlan; setPlan: (p: DealPlan) => void; owner: string }) {
  const set = <K extends keyof DealPlan>(k: K, v: DealPlan[K]) => setPlan({ ...plan, [k]: v });
  const price = (k: keyof DealPlan["prices"]) => (n: number) => set("prices", { ...plan.prices, [k]: n });
  const buyer = role === "buyer";
  return (
    <div className="space-y-4">
      <Section title="Your price range" icon={<Target className="h-3.5 w-3.5" />}>
          <PriceTrack role={role} plan={plan} />
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PriceInput label="Open" value={plan.prices.open} onChange={price("open")} tone="text-slate-600" />
            <PriceInput label="Target" value={plan.prices.target} onChange={price("target")} tone="text-emerald-700" />
            <PriceInput label="Happy at" value={plan.prices.happy} onChange={price("happy")} tone="text-emerald-700" />
            <PriceInput label={buyer ? "Max" : "Min"} value={plan.prices.limit} onChange={price("limit")} tone="text-rose-700" secret />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            <Lock className="mr-1 inline h-3 w-3" />
            Your {buyer ? "max" : "min"} never leaves this proxy. Anything past "happy" needs your YES by text.
          </p>
        </Section>
        <Section title="What it really sells for" icon={<Search className="h-3.5 w-3.5" />}>
          <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <p className="text-sm leading-relaxed text-slate-700">{plan.marketRead}</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {plan.comps.map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge variant={c.kind === "new" ? "default" : c.kind === "refurbished" ? "violet" : c.kind === "sold" ? "green" : "blue"}>{c.kind}</Badge>
                  <span className="truncate text-slate-700">{c.label}</span>
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 text-slate-400 hover:text-slate-700" title={c.url}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </span>
                <span className="font-semibold tabular-nums">{money(c.price)}</span>
              </li>
            ))}
          </ul>
          </div>
        </Section>
      <Section title="Counter ladder" icon={<span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[8px] font-bold">1</span>}>
        <div className="space-y-2">
          {plan.ladder.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-slate-900 text-xs font-bold">{i + 1}</span>
              <div className="relative w-28 shrink-0">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">$</span>
                <input
                  type="number"
                  value={s.amount || ""}
                  onChange={(e) => set("ladder", plan.ladder.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))}
                  className={cn(field, "py-1.5 pl-6 font-semibold tabular-nums")}
                />
              </div>
              <textarea
                value={s.reason}
                rows={1}
                onChange={(e) => set("ladder", plan.ladder.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))}
                className={cn(field, "resize-none py-1.5")}
              />
              <Button size="sm" variant="ghost" onClick={() => set("ladder", plan.ladder.filter((_, j) => j !== i))} title="Remove">✕</Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => set("ladder", [...plan.ladder, { amount: plan.ladder.at(-1)?.amount ?? plan.prices.open, reason: "" }])}>
            Add a step
          </Button>
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Opening text" icon={<MessageSquareText className="h-3.5 w-3.5" />}>
          <textarea value={plan.opener} onChange={(e) => set("opener", e.target.value)} rows={3} className={field} />
          <p className="mt-1 text-xs text-slate-500">Sent first, as {owner}'s AI assistant. No price.</p>
        </Section>
        <Section title="Questions to ask first">
          <ListEdit value={plan.discovery} onChange={(v) => set("discovery", v)} rows={4} />
        </Section>
        <Section title="What they probably care about">
          <ul className="space-y-2 text-sm">
            {plan.theirInterests.map((x, i) => (
              <li key={i} className="rounded-lg bg-slate-50 p-2.5">
                <div className="font-medium text-slate-800">{x.signal}</div>
                <div className="text-slate-600">→ {x.use}</div>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Trades beyond price">
          <ListEdit value={plan.trades} onChange={(v) => set("trades", v)} rows={4} />
        </Section>
        <Section title="Tactics" icon={<Wand2 className="h-3.5 w-3.5" />}>
          <ListEdit value={plan.tactics} onChange={(v) => set("tactics", v)} rows={4} />
          <p className="mt-1 text-xs text-slate-500">From Never Split the Difference and Harvard's negotiation program.</p>
        </Section>
        <Section title="Check with you before" icon={<ShieldCheck className="h-3.5 w-3.5" />}>
          <ListEdit value={plan.checkWithOwner} onChange={(v) => set("checkWithOwner", v)} rows={3} />
        </Section>
        <Section title="Dealbreakers" className="border-rose-200 bg-rose-50/40">
          <ListEdit value={plan.dealbreakers} onChange={(v) => set("dealbreakers", v)} rows={3} />
        </Section>
        <Section title="Nice to have" className="border-emerald-200 bg-emerald-50/40">
          <ListEdit value={plan.niceToHaves} onChange={(v) => set("niceToHaves", v)} rows={3} />
        </Section>
      </div>
      <Section title="Walk away">
        <textarea value={plan.walkAway} onChange={(e) => set("walkAway", e.target.value)} rows={2} className={field} />
      </Section>
    </div>
  );
}

const Row = ({ k, v }: { k: ReactNode; v: ReactNode }) => (
  <div className="flex justify-between gap-3 py-1">
    <span className="text-slate-500">{k}</span>
    <span className="text-right font-medium">{v}</span>
  </div>
);

export function MarketplacePage() {
  const { proxy } = useProxy();
  const health = useHealth();
  const navigate = useNavigate();
  const [listing, setListing] = useState("");
  const [notes, setNotes] = useState("");
  const [plan, setPlan] = useState<DealPlan | null>(null);
  const [searches, setSearches] = useState(0);
  const [queries, setQueries] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  const [sellers, setSellers] = useState<Seller[]>([{ name: "", phone: "", listing: "" }]);
  const setSeller = (i: number, patch: Partial<Seller>) => setSellers((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const [channel, setChannel] = useState<ChannelPref>("text");
  const [strategy, setStrategy] = useState<Strategy>("coach");
  const [parsed, setParsed] = useState<ParsedListing | null>(null);
  const [busy, setBusy] = useState<"plan" | "revise" | "parse" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const role: Role = health.data?.role ?? "buyer";
  const owner = health.data?.owner ?? "you";
  const other = role === "buyer" ? "seller" : "buyer";
  const step: 1 | 2 | 3 = parsed ? 3 : plan ? 2 : 1;
  const problems = plan ? planProblems(role, clean(plan)) : [];

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>) => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const generate = (revise = false) =>
    run(revise ? "revise" : "plan", async () => {
      const r = await request<PlanResult>(proxy.url, "/api/plans/generate", {
        method: "POST",
        body: JSON.stringify(revise && plan ? { listing, notes, previous: clean(plan), feedback } : { listing, notes }),
      });
      setPlan(r.plan);
      setSearches((n) => (revise ? n + r.searches : r.searches));
      setQueries((q) => (revise ? [...q, ...(r.queries ?? [])] : (r.queries ?? [])));
      setParsed(null);
      if (revise) setFeedback("");
    });

  const confirmPlan = (withPlan: boolean) =>
    run("parse", async () => {
      const p = await request<ParsedListing>(proxy.url, "/api/listings/parse", {
        method: "POST",
        body: JSON.stringify({ listing, brief: notes, ...(withPlan && plan ? { plan: clean(plan) } : {}) }),
      });
      setParsed(p);
      if (p.listerName) setSellers((xs) => (xs[0].name ? xs : [{ ...xs[0], name: p.listerName! }, ...xs.slice(1)]));
    });

  const create = () =>
    run("create", async () => {
      if (!parsed) return;
      const common = { item: parsed.item, mandate: parsed.mandate, start: true, channelPref: channel, strategy, listing, brief: notes, ...(plan ? { plan: clean(plan) } : {}) };
      if (ready.length > 1) {
        // Several sellers: one search, one negotiation each, at most one winner.
        const r = await request<{ hunt: { id: string } }>(proxy.url, "/api/hunts", {
          method: "POST",
          body: JSON.stringify({ ...common, sellers: ready.map((x) => ({ name: x.name.trim(), phone: x.phone.trim(), listing: x.listing.trim() })) }),
        });
        navigate(`/hunts/${r.hunt.id}`);
        return;
      }
      const id = newId();
      await request(proxy.url, "/api/deals", {
        method: "POST",
        body: JSON.stringify({ ...common, id, counterparty: { name: ready[0].name.trim(), phone: ready[0].phone.trim() } }),
      });
      navigate(`/deals/${id}`);
    });

  const m = parsed?.mandate;
  const blocked = parsed?.warnings.some((w) => /\bopens at\b/i.test(w));
  const ready = sellers.filter((x) => x.phone.replace(/\D/g, "").length >= 10);
  const dupes = new Set(ready.map((x) => x.phone.replace(/\D/g, "").slice(-10))).size !== ready.length;
  const canCreate = parsed && ready.length > 0 && !dupes && (ready.length === 1 || Boolean(plan)) && !blocked && !problems.length;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-sky-900 p-6 text-white shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-sky-300">
              <ShoppingBag className="h-4 w-4" /> Marketplace negotiator
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Paste a listing. Get a game plan. Let your assistant haggle.</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-300">
              Claude researches what the item really sells for and drafts a negotiation plan for you to edit. Then Fo texts the {other} as {owner}'s AI
              assistant, Claude decides every move, and nothing is final until you text back YES.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 text-xs">
            <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1"><Lock className="h-3 w-3" /> Your limits stay private</span>
            <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1"><ShieldCheck className="h-3 w-3" /> You approve every deal</span>
            <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1"><Check className="h-3 w-3" /> No money moves through Fo</span>
          </div>
        </div>
        <div className="mt-5 rounded-lg bg-white/95 px-4 py-2.5 text-slate-900">
          <Stepper step={step} />
        </div>
      </div>

      {/* Step 1 */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">1</span> Listing and goals
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400">Examples:</span>
            {EXAMPLES.map((x) => (
              <Button key={x.name} size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setListing(x.listing); setNotes(x.notes); setPlan(null); setParsed(null); }}>
                {x.name}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <ShoppingBag className="h-3.5 w-3.5" /> The listing <span className="font-normal normal-case text-slate-400">(public, paste from Marketplace)</span>
              </span>
              <textarea value={listing} onChange={(e) => setListing(e.target.value)} rows={7} placeholder={EXAMPLES[0].listing} className={field} />
            </label>
            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Lock className="h-3.5 w-3.5" /> What you want <span className="font-normal normal-case text-slate-400">(private, only your agent sees this)</span>
              </span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={7} placeholder={EXAMPLES[0].notes} className={cn(field, "bg-amber-50/40")} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={() => generate(false)} disabled={!listing.trim() || busy !== null}>
              <Sparkles className="h-4 w-4" /> {busy === "plan" ? "Researching comps…" : plan ? "Start the plan over" : "Generate game plan"}
            </Button>
            {!plan && (
              <Button variant="ghost" size="sm" onClick={() => confirmPlan(false)} disabled={!listing.trim() || busy !== null}>
                Skip the plan
              </Button>
            )}
            {busy === "plan" && (
              <span className="flex items-center gap-2 text-sm text-slate-500">
                <span className="h-2 w-2 animate-ping rounded-full bg-sky-500" /> Searching the web for prices and building your plan. This takes about a minute.
              </span>
            )}
          </div>
          {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </CardContent>
      </Card>

      {/* Step 2 */}
      {plan && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">2</span> Game plan
              <Badge variant="blue"><Search className="h-3 w-3" /> {searches} web searches</Badge>
            </CardTitle>
            <span className="text-xs text-slate-500">Edit anything, or ask Claude to change it.</span>
          </CardHeader>
          <CardContent className="space-y-4 bg-slate-50/60">
            {queries.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="flex items-center gap-1 font-semibold uppercase tracking-wide text-slate-500"><Search className="h-3.5 w-3.5" /> Claude searched</span>
                {queries.map((q, i) => (
                  <span key={i} className="animate-event-in rounded-full border border-sky-200 bg-white px-2.5 py-1 text-sky-800" style={{ animationDelay: `${i * 150}ms` }}>“{q}”</span>
                ))}
              </div>
            )}
            <PlanEditor role={role} plan={plan} setPlan={(p) => { setPlan(p); setParsed(null); }} owner={owner} />
            <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-800">
                <Wand2 className="h-3.5 w-3.5" /> Ask Claude to change the plan
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && feedback.trim() && busy === null && generate(true)}
                  placeholder='e.g. "Be more aggressive, open at $200" or "Lead with the quick pickup"'
                  className={cn(field, "py-2")}
                />
                <Button onClick={() => generate(true)} disabled={!feedback.trim() || busy !== null} className="shrink-0">
                  <RefreshCw className={cn("h-3.5 w-3.5", busy === "revise" && "animate-spin")} /> {busy === "revise" ? "Revising…" : "Revise"}
                </Button>
              </div>
            </div>
            {problems.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                {problems.map((w) => <div key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}</div>)}
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button size="lg" variant="success" onClick={() => confirmPlan(true)} disabled={busy !== null || problems.length > 0}>
                <Check className="h-4 w-4" /> {busy === "parse" ? "Setting up…" : "Use this plan"}
              </Button>
              {error && step === 2 && <span className="text-sm text-red-600">{error}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3 */}
      {parsed && m && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">3</span> Start
            </CardTitle>
            <Badge variant="outline">{owner} is the {role}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium">{parsed.summary}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-4 text-sm">
                <div className="mb-2 font-semibold">Your agent's limits</div>
                <Row k="Opens at" v={money(m.openingOffer)} />
                {plan && <Row k="Aims for" v={money(plan.prices.target)} />}
                <Row k={<span className="flex items-center gap-1"><Lock className="h-3 w-3" /> {role === "buyer" ? "Never above" : "Never below"}</span>} v={money(m.floorOrCeiling)} />
                <Row k="Dealbreakers" v={m.dealbreakers.join("; ") || "none"} />
              </div>
              <div className="space-y-2 rounded-xl border border-slate-200 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Who to text</span>
                  {sellers.length > 1 && <Badge variant="blue"><Users className="h-3 w-3" /> {sellers.length} sellers, one winner</Badge>}
                </div>
                {sellers.map((x, i) => (
                  <div key={i} className={cn("space-y-1.5", sellers.length > 1 && "rounded-lg bg-slate-50 p-2")}>
                    <div className="flex gap-2">
                      <input value={x.name} onChange={(e) => setSeller(i, { name: e.target.value })} placeholder={`${other[0].toUpperCase()}${other.slice(1)}'s name`} className={cn(field, "py-1.5")} />
                      <input value={x.phone} onChange={(e) => setSeller(i, { phone: e.target.value })} placeholder="Phone, e.g. +1 415 555 0100" className={cn(field, "py-1.5")} />
                      {sellers.length > 1 && (
                        <Button size="sm" variant="ghost" className="h-auto" title="Remove" onClick={() => setSellers((xs) => xs.filter((_, j) => j !== i))}>✕</Button>
                      )}
                    </div>
                    {sellers.length > 1 && i > 0 && (
                      <textarea value={x.listing} onChange={(e) => setSeller(i, { listing: e.target.value })} rows={1} placeholder="Their listing, if it's a different one (optional)" className={cn(field, "py-1.5 text-xs")} />
                    )}
                  </div>
                ))}
                {role === "buyer" && sellers.length < 5 && (
                  <Button size="sm" variant="outline" onClick={() => setSellers((xs) => [...xs, { name: "", phone: "", listing: "" }])}>
                    <Users className="h-3.5 w-3.5" /> Add another seller
                  </Button>
                )}
                {sellers.length > 1 && !plan && <div className="text-xs text-amber-700">Several sellers share one game plan: generate one first.</div>}
                {dupes && <div className="text-xs text-amber-700">Two sellers have the same number.</div>}
                <div className="text-xs text-slate-500">
                  Your YES texts go to{" "}
                  {parsed.ownerPhone ? (
                    <span className="font-medium text-slate-700">{parsed.ownerPhone}</span>
                  ) : (
                    <span className="font-medium text-amber-700">nobody: set OWNER_NOTIFY_PHONE (until then, approve on the dashboard)</span>
                  )}
                </div>
              </div>
            </div>
            {parsed.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                {parsed.warnings.map((w) => <div key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}</div>)}
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Reach them by</div>
                <div className="flex flex-wrap gap-2">
                  {CHANNELS.map((c) => (
                    <Button key={c.value} size="sm" variant={channel === c.value ? "default" : "outline"} onClick={() => setChannel(c.value)}>
                      {c.icon} {c.label}
                    </Button>
                  ))}
                </div>
                {channel !== "text" && <p className="mt-1.5 text-xs text-slate-500">Fo negotiates live on the call, then texts to lock it in after your YES.</p>}
              </div>
              <div>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Who runs the conversation</div>
                <div className="flex flex-wrap gap-2">
                  {STRATEGIES.map((st) => (
                    <Button key={st.value} size="sm" variant={strategy === st.value ? "default" : "outline"} onClick={() => setStrategy(st.value)}>
                      {st.label}
                    </Button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-slate-500">{STRATEGIES.find((st) => st.value === strategy)?.hint}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button size="lg" onClick={create} disabled={busy !== null || !canCreate}>
                <ArrowRight className="h-4 w-4" /> {busy === "create" ? "Starting…" : ready.length > 1 ? `Start with ${ready.length} sellers` : "Start negotiating"}
              </Button>
              <span className="text-xs text-slate-500">
                {health.data?.mockFo ? "Mock Fo: nothing is really sent. Play the other side from the deal page." : `Starting ${channel === "text" ? "sends real texts" : "can place real calls"} from your Fo to ${ready.map((x) => x.name || x.phone).join(", ") || "this number"}.`}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
