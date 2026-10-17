import { FastForward, Pause, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_GAP_MS, REPLAY_SPEED, type Replay } from "@/lib/replay";
import type { Actor, Event } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Empty } from "./common";
import { ACTOR_STYLE, EventItem } from "./EventItem";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle } from "./ui/card";

const ACTORS: Actor[] = ["claude", "fo", "human", "system"];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors cursor-pointer",
        on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
      )}
    >
      {children}
    </button>
  );
}

const toggle = <T,>(set: Set<T>, v: T) => {
  const next = new Set(set);
  next.has(v) ? next.delete(v) : next.add(v);
  return next;
};

export function Timeline({ allEvents, replay }: { allEvents: Event[]; replay: Replay }) {
  const [actors, setActors] = useState<Set<Actor>>(new Set());
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    allEvents.forEach((e) => m.set(e.kind, (m.get(e.kind) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [allEvents]);

  const visible = replay.events.filter((e) => (!actors.size || actors.has(e.actor)) && (!kinds.size || kinds.has(e.kind)));

  // Auto-scroll to newest (bottom) while the user is near the bottom, always during replay.
  useEffect(() => {
    const el = scroller.current;
    if (el && (stick.current || replay.active)) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [visible.length, replay.active]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <Card className="flex h-[calc(100vh-210px)] min-h-[480px] flex-col">
      <CardHeader className="flex-wrap">
        <CardTitle>
          Timeline <span className="font-normal text-slate-400">({visible.length}/{replay.active ? replay.total : allEvents.length})</span>
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {replay.active ? (
            <>
              <span className="inline-flex items-center gap-1 rounded bg-violet-600 px-1.5 py-0.5 font-mono text-[11px] font-bold text-white" title={`gaps compressed ${REPLAY_SPEED}x, capped at ${MAX_GAP_MS / 1000}s`}>
                <FastForward className="h-3 w-3" /> {REPLAY_SPEED}x
              </span>
              <Button size="sm" variant="outline" onClick={replay.toggle} disabled={replay.shown >= replay.total}>
                {replay.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <Button size="sm" variant="outline" onClick={replay.start} title="Restart">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="outline" onClick={replay.stop}>
                <Square className="h-3.5 w-3.5" /> Live
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={replay.start} disabled={!allEvents.length}>
              <Play className="h-3.5 w-3.5" /> Replay
            </Button>
          )}
        </div>
      </CardHeader>

      {replay.active && (
        <div className="border-b border-slate-100 px-4 py-2">
          <div className="mb-1 flex justify-between text-[11px] text-slate-500 tabular-nums">
            <span>
              Replaying {replay.shown}/{replay.total} events
            </span>
            <span>{replay.playing ? `~${Math.ceil(replay.remainingMs / 1000)}s left` : replay.shown >= replay.total ? "done" : "paused"}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-violet-600 transition-[width] duration-300" style={{ width: `${replay.progress * 100}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-4 py-2">
        {ACTORS.map((a) => (
          <Chip key={a} on={actors.has(a)} onClick={() => setActors(toggle(actors, a))}>
            <span className={cn("h-2 w-2 rounded-full", ACTOR_STYLE[a].dot)} />
            {ACTOR_STYLE[a].label}
          </Chip>
        ))}
        <span className="mx-1 h-4 w-px bg-slate-200" />
        {kindCounts.map(([k, n]) => (
          <Chip key={k} on={kinds.has(k)} onClick={() => setKinds(toggle(kinds, k))}>
            {k} <span className="opacity-60">{n}</span>
          </Chip>
        ))}
        {(actors.size > 0 || kinds.size > 0) && (
          <button className="ml-1 text-xs text-sky-700 underline cursor-pointer" onClick={() => (setActors(new Set()), setKinds(new Set()))}>
            clear
          </button>
        )}
      </div>

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto bg-slate-50 px-3 py-3">
        {visible.length === 0 ? (
          <Empty>{replay.active ? "Starting replay…" : "No events yet."}</Empty>
        ) : (
          <ol className="relative space-y-2 before:absolute before:bottom-2 before:left-[18px] before:top-2 before:w-px before:bg-slate-200">
            {visible.map((e) => (
              <EventItem key={e.id} event={e} animate={replay.active} />
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
