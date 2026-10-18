import { AlertTriangle, Lock, ShoppingBag, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { request, useHealth } from "@/lib/api";
import { useProxy } from "@/lib/proxy";
import type { ChannelPref, ParsedListing, Strategy } from "@/lib/types";
import { cn, money } from "@/lib/utils";

// The Impossible E-Bike (scenarios/the-impossible-ebike.md): price alone can't work; the furniture bundle can.
const EXAMPLE_LISTING =
  "FOR SALE: 2023 Rad Power RadCity 5 Plus e-bike (step-thru, grey), ~800 miles. Always stored indoors, new brake pads in August. " +
  "Charger included. $1,400. Pickup in the Mission, SF.";
const EXAMPLE_BRIEF =
  "I just moved to SF for a new job in SoMa; first day is Monday 9am and I need the bike before then (bus 40 min, bike 18). " +
  "My studio is unfurnished: mattress on the floor, working at the kitchen counter. $950 is my absolute max (it's what's left in savings), " +
  "and I'll only go above $900 if a lock is included. I must get the charger. What things are worth to me: bike + charger ~$1,300, " +
  "a couch ~$300, a desk ~$150, a lock ~$60, a helmet ~$40, a wall hook $0 (I rent). No car, but my friend Priya can lend her pickup " +
  "truck and help carry Saturday 10am-2pm only. I can pay cash or Venmo on pickup. If this falls through I take the bus; comparable bikes are $1,000+.";

const CHANNELS: { value: ChannelPref; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "call", label: "Phone call" },
  { value: "auto", label: "Agent picks" },
];

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: "handoff", label: "Claude plans, Fo negotiates", hint: "Claude builds the whole strategy first and hands it to Fo in one go. Fo runs the conversation; Claude watches and steps in." },
  { value: "coach", label: "Claude coaches live", hint: "Claude reads every reply and tells Fo the next move." },
];

const newId = () => `PD-${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

const Row = ({ k, v }: { k: ReactNode; v: ReactNode }) => (
  <div className="flex justify-between gap-3 py-1">
    <span className="text-slate-500">{k}</span>
    <span className="text-right font-medium">{v}</span>
  </div>
);
const Private = ({ children }: { children: ReactNode }) => (
  <span className="flex items-center gap-1">
    <Lock className="h-3 w-3" /> {children}
  </span>
);

export function MarketplacePage() {
  const { proxy } = useProxy();
  const health = useHealth();
  const navigate = useNavigate();
  const [listing, setListing] = useState("");
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<ChannelPref>("text");
  const [strategy, setStrategy] = useState<Strategy>("handoff");
  const [parsed, setParsed] = useState<ParsedListing | null>(null);
  const [busy, setBusy] = useState<"parse" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const role = health.data?.role ?? "buyer";
  const other = role === "buyer" ? "seller" : "buyer";

  const parse = async () => {
    setBusy("parse");
    setError(null);
    setParsed(null);
    try {
      const p = await request<ParsedListing>(proxy.url, "/api/listings/parse", { method: "POST", body: JSON.stringify({ listing, brief }) });
      setParsed(p);
      if (!name && p.listerName) setName(p.listerName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!parsed) return;
    setBusy("create");
    setError(null);
    const id = newId();
    try {
      await request(proxy.url, "/api/deals", {
        method: "POST",
        body: JSON.stringify({ id, item: parsed.item, mandate: parsed.mandate, start: true, channelPref: channel, strategy, counterparty: { name: name.trim(), phone: phone.trim() } }),
      });
      navigate(`/deals/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const m = parsed?.mandate;
  const blocked = parsed?.warnings.some((w) => /\bopens at\b/i.test(w));
  const canCreate = parsed && phone.replace(/\D/g, "").length >= 10 && !blocked;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-sky-600" /> Marketplace deal
          </CardTitle>
          <Badge variant="outline">
            {health.data?.owner ?? "this agent"} is the {role}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">
            Paste the listing and tell the agent what you want. Claude runs the negotiation and Fo sends the texts to a real person.
            Before any deal is final, Fo texts you for a YES. No money moves through Fo.
          </p>
          <label className="block text-xs font-semibold uppercase text-slate-500">Listing (paste from Marketplace)</label>
          <textarea
            value={listing}
            onChange={(e) => setListing(e.target.value)}
            rows={4}
            placeholder={EXAMPLE_LISTING}
            className="w-full rounded-md border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <label className="block text-xs font-semibold uppercase text-slate-500">
            Your goals and limits <span className="font-normal normal-case text-slate-400">(private, only the agent sees this)</span>
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={5}
            placeholder={EXAMPLE_BRIEF}
            className="w-full rounded-md border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { setListing(EXAMPLE_LISTING); setBrief(EXAMPLE_BRIEF); }}>
              Use e-bike example
            </Button>
            <Button size="sm" onClick={parse} disabled={!listing.trim() || busy !== null}>
              <Sparkles className="h-3.5 w-3.5" /> {busy === "parse" ? "Reading…" : "Read listing"}
            </Button>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </CardContent>
      </Card>

      {parsed && m && (
        <Card>
          <CardHeader>
            <CardTitle>Check before starting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium">{parsed.summary}</p>
            <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Item</div>
              {parsed.item}
              {parsed.askingPrice != null && <div className="mt-1 font-medium">Listed at {money(parsed.askingPrice)}</div>}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="mb-2 font-semibold">Your agent's mandate</div>
                <Row k="Opens at" v={money(m.openingOffer)} />
                <Row k={<Private>{role === "buyer" ? "Highest price" : "Lowest price"}</Private>} v={money(m.floorOrCeiling)} />
                <Row k="Max move per round" v={money(m.maxConcessionPerRound)} />
                <Row k="Dealbreakers" v={m.dealbreakers.join("; ") || "none"} />
                <Row k={<Private>Private notes</Private>} v={Object.entries(m.secrets).map(([k, v]) => `${k}: ${v}`).join("; ") || "none"} />
              </div>
              <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
                <div className="font-semibold">Who to text</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${other[0].toUpperCase()}${other.slice(1)}'s name`}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={`${other[0].toUpperCase()}${other.slice(1)}'s phone, e.g. +1 415 555 0100`}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
                <div className="text-xs text-slate-500">
                  Owner sign-off texts go to{" "}
                  {parsed.ownerPhone ? (
                    <span className="font-medium text-slate-700">{parsed.ownerPhone}</span>
                  ) : (
                    <span className="font-medium text-amber-700">nobody: set OWNER_NOTIFY_PHONE (until then, approve on the dashboard)</span>
                  )}
                </div>
              </div>
            </div>
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
              <span className="text-xs text-slate-500">Reach them by</span>
              {CHANNELS.map((c) => (
                <Button key={c.value} size="sm" variant={channel === c.value ? "default" : "outline"} onClick={() => setChannel(c.value)}>
                  {c.label}
                </Button>
              ))}
              {channel !== "text" && (
                <span className="text-xs text-slate-500">Fo negotiates live on the call, then texts to lock it in after your YES.</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Strategy</span>
              {STRATEGIES.map((st) => (
                <Button key={st.value} size="sm" title={st.hint} variant={strategy === st.value ? "default" : "outline"} onClick={() => setStrategy(st.value)}>
                  {st.label}
                </Button>
              ))}
              <span className="text-xs text-slate-500">{STRATEGIES.find((st) => st.value === strategy)?.hint}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={create} disabled={busy !== null || !canCreate} className={cn(!canCreate && "opacity-50")}>
                {busy === "create" ? "Starting…" : "Start negotiating"}
              </Button>
              <span className="text-xs text-slate-500">
                {health.data?.mockFo ? "Mock Fo: nothing is really sent. Play the other side from the deal page." : `Starting ${channel === "text" ? "sends real texts" : "can place real calls"} from your Fo to ${phone || "this number"}.`}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
