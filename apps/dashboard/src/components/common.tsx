import { Loader2, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { OfflineError } from "@/lib/api";
import { useProxy } from "@/lib/proxy";
import { STAGES, type Deal, type Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";

/** Shows loading / offline / error states; renders children only when data is present. */
export function QueryState({ isPending, error, children }: { isPending: boolean; error: Error | null; children: ReactNode }) {
  const { proxy } = useProxy();
  if (error instanceof OfflineError || (error && isPending)) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-red-300 bg-red-50/50 px-6 py-12 text-center">
        <WifiOff className="h-8 w-8 text-red-500" />
        <div className="font-semibold text-red-700">Proxy offline</div>
        <div className="text-sm text-slate-600">
          Can't reach <code className="font-mono">{proxy.url}</code>. Retrying every 3s…
        </div>
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  return (
    <>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</div>
      )}
      {children}
    </>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-sm text-slate-500">{children}</div>;
}

export const stageLabel = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function StageBadge({ stage, className }: { stage: string; className?: string }) {
  const variant = stage === "CLOSED" ? "green" : stage === "ABANDONED" ? "red" : stage === "NEGOTIATING" ? "blue" : "violet";
  return (
    <Badge variant={variant} className={cn("font-mono uppercase tracking-wide text-[10px]", className)}>
      {stage.replace(/_/g, " ")}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: Deal["status"] }) {
  const variant = ({ active: "green", paused: "amber", closed: "dark", abandoned: "red" } as const)[status];
  return <Badge variant={variant}>{status}</Badge>;
}

/** Horizontal stage progress strip (ABANDONED shown as terminal red if reached). */
export function StageStrip({ stage }: { stage: Stage }) {
  const path = STAGES.filter((s) => s !== "ABANDONED");
  const idx = path.indexOf(stage as (typeof path)[number]);
  const abandoned = stage === "ABANDONED";
  return (
    <div className="flex w-full gap-1">
      {path.map((s, i) => {
        const done = !abandoned && i < idx;
        const current = !abandoned && i === idx;
        return (
          <div key={s} className="flex min-w-0 flex-1 flex-col gap-1">
            <div
              className={cn(
                "h-1.5 rounded-full",
                done ? "bg-emerald-500" : current ? (s === "CLOSED" ? "bg-emerald-500" : "bg-sky-500") : abandoned ? "bg-red-200" : "bg-slate-200",
              )}
            />
            <div className={cn("truncate text-[10px] uppercase tracking-wide", current ? "font-semibold text-slate-900" : "text-slate-400")} title={s}>
              {s.replace(/_/g, " ")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-72 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100", className)}>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
