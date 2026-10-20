"use client";

import { useRef } from "react";

// Runs `job` unless the previous one is still running: a second pick of "Pause monitors" while the first is on its
// way is ignored. A ref, not state, so a double click inside one render can't slip through.
export function runOnce(busy: { current: boolean }, job: () => Promise<void>): boolean {
  if (busy.current) return false;
  busy.current = true;
  // The job reports its own errors (a toast); a rejection only has to free the guard again.
  void job().catch(() => undefined).finally(() => {
    busy.current = false;
  });
  return true;
}

export function useOnce(): (job: () => Promise<void>) => boolean {
  const busy = useRef(false);
  return (job) => runOnce(busy, job);
}
