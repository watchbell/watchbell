"use client";

import { useEffect, useState } from "react";
import { markCollectorRun } from "@/components/live";
import { collectorHealth, DEMO_COLLECTOR_TEXT } from "@/lib/collector/status";
import { cn } from "@/lib/utils";

const DOT = { ok: "bg-ok", warn: "bg-warn-icon", err: "bg-err", idle: "bg-idle" } as const;

// demo: no collector runs in demo mode, so the footer says so and doesn't poll.
export function CollectorStatus({ initialLastRunAt, initialNow, demo = false }: { initialLastRunAt: string | null; initialNow: number; demo?: boolean }) {
  const [lastRunAt, setLastRunAt] = useState(initialLastRunAt);
  const [now, setNow] = useState(initialNow);
  // 1.2.3: the refresh picker's Auto refreshes the page once a run newer than its data is known.
  useEffect(() => {
    markCollectorRun(demo || !lastRunAt ? null : Date.parse(lastRunAt));
  }, [lastRunAt, demo]);

  useEffect(() => {
    if (demo) return;
    const refresh = () => {
      fetch("/api/status", { cache: "no-store" })
        .then((r) => {
          // A signed-out session gets a 401 JSON or a redirect to the sign-in page (HTML): keep what we last knew.
          if (!r.ok || r.redirected || !(r.headers.get("content-type") ?? "").includes("application/json")) return null;
          return r.json();
        })
        .then((j: { lastRunAt?: string | null } | null) => {
          if (j && typeof j === "object" && "lastRunAt" in j) {
            setLastRunAt(j.lastRunAt ?? null);
            setNow(Date.now());
          }
        })
        .catch(() => undefined);
    };
    // A hidden tab doesn't poll (final review M9: a forgotten tab would cost ~2,880 calls a day); it catches up as soon
    // as it is visible again.
    const visible = () => document.visibilityState === "visible";
    const poll = () => {
      if (visible()) refresh();
    };
    const onVisibility = () => {
      if (visible()) refresh();
    };
    // The sidebar remounts when it is collapsed and reopened, with the values from page load: refresh right away.
    poll();
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    const timer = setInterval(poll, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(tick);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [demo]);

  const h = demo ? { state: "ok" as const, text: DEMO_COLLECTOR_TEXT } : collectorHealth(lastRunAt ? new Date(lastRunAt) : null, new Date(now));
  return (
    <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-ink-soft" aria-live="off">
      <span className={cn("size-2 shrink-0 rounded-full", DOT[h.state])} aria-hidden />
      {h.text}
    </div>
  );
}
