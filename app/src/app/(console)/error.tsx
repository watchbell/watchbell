"use client";

import { useEffect } from "react";
import { ErrorView } from "@/components/error-view";
import { demoNoticeForDigest } from "@/lib/demo/notices";
import { retryDelay } from "@/lib/view/refresh";

// The backoff outlives one showing of this screen (a failed retry shows it again); two quiet minutes start it over.
let attempt = 0;
let lastRetryAt = 0;
const QUIET_MS = 120_000;

function resetIfQuiet(now: number) {
  if (now - lastRetryAt > QUIET_MS) attempt = 0;
}

function retryIfDue(shownAt: number, retry: () => void) {
  if (document.visibilityState !== "visible" || navigator.onLine === false) return;
  const now = Date.now();
  if (now - Math.max(shownAt, lastRetryAt) < retryDelay(attempt)) return;
  attempt += 1;
  lastRetryAt = now;
  retry();
}

// Inside the console shell, so the navigation stays usable while a page fails. A failed background refresh lands
// here too (final review I2), so a console left open on a second screen retries on its own while the tab is visible
// (15 s, 22.5 s, then every 30 s) instead of staying on this screen until someone presses Try again.
export default function ConsoleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    const shownAt = Date.now();
    resetIfQuiet(shownAt);
    const timer = setInterval(() => retryIfDue(shownAt, retry), 1000);
    return () => clearInterval(timer);
  }, [retry]);
  // The demo's "busy" and "too many new sessions" arrive as a fixed digest (lib/demo/notices.ts); anything else as a hash.
  return <ErrorView digest={error.digest} retry={retry} note="Retrying…" notice={demoNoticeForDigest(error.digest) ?? undefined} />;
}
