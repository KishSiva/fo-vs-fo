import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { POLL_MS, request } from "@/lib/api";
import { useProxy } from "@/lib/proxy";
import type { DealDetail, Health } from "@/lib/types";
import { cn, time } from "@/lib/utils";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface Msg { from: string; to: string; text: string; at: string }

/** One phone on the mock network: what Fo sent this number, and a box to text Fo back as that person. */
function Phone({ who, phone }: { who: string; phone: string }) {
  const { proxy } = useProxy();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const key = [proxy.url, "mock-thread", phone];
  const thread = useQuery({
    queryKey: key,
    queryFn: () => request<Msg[]>(proxy.url, `/api/mock/thread?with=${encodeURIComponent(phone)}`),
    refetchInterval: POLL_MS,
    retry: false,
  });
  const send = async () => {
    if (!text.trim()) return;
    setErr(null);
    try {
      await request(proxy.url, "/api/mock/text", { method: "POST", body: JSON.stringify({ from: phone, text }) });
      setText("");
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-md border border-slate-200">
      <div className="border-b border-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">
        {who} <span className="font-normal text-slate-400">{phone}</span>
      </div>
      <div className="flex max-h-72 min-h-24 flex-col gap-1.5 overflow-y-auto p-2">
        {(thread.data ?? []).map((m, i) => {
          const mine = m.from === phone;
          return (
            <div key={i} className={cn("max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm", mine ? "self-end bg-sky-600 text-white" : "self-start bg-slate-100 text-slate-800")}>
              <div className="whitespace-pre-wrap">{m.text}</div>
              <div className={cn("text-[10px]", mine ? "text-sky-100" : "text-slate-400")}>{time(m.at)}</div>
            </div>
          );
        })}
        {!thread.data?.length && <div className="text-xs text-slate-400">No texts yet.</div>}
      </div>
      <div className="flex gap-1.5 border-t border-slate-100 p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder={`Text as ${who}…`}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
        <Button size="sm" onClick={() => void send()} disabled={!text.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
      {err && <div className="px-2 pb-2 text-xs text-red-600">{err}</div>}
    </div>
  );
}

/** Mock Fo only: rehearse a marketplace deal by playing the other side and the owner. */
export function Rehearsal({ deal, health }: { deal: DealDetail; health?: Health }) {
  if (!health?.mockFo || deal.counterparty.kind !== "human" || !deal.counterparty.phone) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rehearsal phones</CardTitle>
        <span className="text-xs text-slate-500">mock Fo: nothing leaves this machine</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Phone who={deal.counterparty.name} phone={deal.counterparty.phone} />
        {health.ownerPhone ? (
          <Phone who={`${health.owner} (owner)`} phone={health.ownerPhone} />
        ) : (
          <div className="text-xs text-amber-700">Set OWNER_NOTIFY_PHONE to rehearse owner sign-off by text.</div>
        )}
      </CardContent>
    </Card>
  );
}
