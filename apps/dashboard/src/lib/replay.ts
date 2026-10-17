import { useEffect, useMemo, useState } from "react";
import type { Event } from "./types";

export const REPLAY_SPEED = 20;
export const MAX_GAP_MS = 1500;

/** Delay (ms) before showing event i during replay: real gap / 20, capped at 1.5s. */
export function replayDelays(events: Event[]): number[] {
  return events.map((e, i) => {
    if (i === 0) return 0;
    const gap = new Date(e.ts).getTime() - new Date(events[i - 1].ts).getTime();
    return Math.min(Math.max(gap, 0) / REPLAY_SPEED, MAX_GAP_MS);
  });
}

/**
 * Replays a snapshot of events from the start. `shown` = number of events currently visible.
 * Returns null cursor when not replaying.
 */
export function useReplay(events: Event[]) {
  const [snapshot, setSnapshot] = useState<Event[] | null>(null);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const delays = useMemo(() => (snapshot ? replayDelays(snapshot) : []), [snapshot]);

  useEffect(() => {
    if (!snapshot || !playing) return;
    if (shown >= snapshot.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setShown((n) => n + 1), delays[shown]);
    return () => clearTimeout(t);
  }, [snapshot, playing, shown, delays]);

  const total = snapshot?.length ?? 0;
  const remainingMs = delays.slice(shown).reduce((a, b) => a + b, 0);
  return {
    active: snapshot != null,
    playing,
    shown,
    total,
    progress: total ? shown / total : 0,
    remainingMs,
    events: snapshot ? snapshot.slice(0, shown) : events,
    /** ts of last visible event during replay; null when live. */
    cursorTs: snapshot ? (snapshot[shown - 1]?.ts ?? "") : null,
    start: () => {
      setSnapshot(events);
      setShown(0);
      setPlaying(true);
    },
    toggle: () => setPlaying((p) => !p),
    stop: () => {
      setSnapshot(null);
      setPlaying(false);
    },
  };
}

export type Replay = ReturnType<typeof useReplay>;
