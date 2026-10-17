import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useProxy } from "./proxy";
import type {
  Approval,
  ChannelPref,
  Command,
  Commitment,
  Deal,
  DealDetail,
  Event,
  Health,
  Offer,
  Scorecard,
  Verification,
} from "./types";

export const POLL_MS = 3000;

export class OfflineError extends Error {}

export async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new OfflineError(`Proxy offline (${base})`);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

/** Polling GET bound to the currently selected proxy. Query keys include the base URL. */
function usePoll<T>(path: string | null, opts: { enabled?: boolean } = {}) {
  const { proxy } = useProxy();
  return useQuery({
    queryKey: [proxy.url, path],
    queryFn: () => request<T>(proxy.url, path!),
    enabled: path != null && opts.enabled !== false,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

export const useHealth = () => usePoll<Health>("/api/health");
export const useDeals = () => usePoll<Deal[]>("/api/deals");
export const useDeal = (id: string) => usePoll<DealDetail>(`/api/deals/${id}`);
export const useOffers = (id: string) => usePoll<Offer[]>(`/api/deals/${id}/offers`);
export const useCommitments = (id: string) => usePoll<Commitment[]>(`/api/deals/${id}/commitments`);
export const useVerifications = (id: string) => usePoll<Verification[]>(`/api/deals/${id}/verifications`);
export const usePendingApprovals = () => usePoll<Approval[]>("/api/approvals?status=pending");
export const useScorecard = () => usePoll<Scorecard>("/api/scorecard");

/** Incrementally polls events with ?after=<last ts> and appends (deduped by id). */
export function useEvents(dealId: string) {
  const { proxy } = useProxy();
  const store = useRef<{ key: string; events: Event[] }>({ key: "", events: [] });
  const key = `${proxy.url}|${dealId}`;
  return useQuery({
    queryKey: [proxy.url, "events", dealId],
    queryFn: async () => {
      if (store.current.key !== key) store.current = { key, events: [] };
      const prev = store.current.events;
      const after = prev.at(-1)?.ts;
      const qs = after ? `?after=${encodeURIComponent(after)}` : "";
      const fresh = await request<Event[]>(proxy.url, `/api/deals/${dealId}/events${qs}`);
      if (store.current.key !== key) return store.current.events;
      const seen = new Set(prev.map((e) => e.id));
      const added = fresh.filter((e) => !seen.has(e.id));
      if (added.length) {
        store.current.events = [...prev, ...added].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
      }
      return store.current.events;
    },
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
    structuralSharing: false,
  });
}

export function useDecideApproval() {
  const { proxy } = useProxy();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "denied" }) =>
      request<Approval>(proxy.url, `/api/approvals/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: [proxy.url] }),
  });
}

export function useDealCommand(dealId: string) {
  const { proxy } = useProxy();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (type: Command) =>
      request<{ ok: true }>(proxy.url, `/api/deals/${dealId}/command`, {
        method: "POST",
        body: JSON.stringify({ type }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: [proxy.url] }),
  });
}

export function useSetChannel(dealId: string) {
  const { proxy } = useProxy();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channel: ChannelPref) =>
      request<{ ok: true }>(proxy.url, `/api/deals/${dealId}/command`, {
        method: "POST",
        body: JSON.stringify({ type: "channel", channel }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: [proxy.url] }),
  });
}
