"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { holdCount } from "@/components/live";
import { AGENTS_REFRESH_MS, agentsRefreshDue } from "@/private/agents/refresh";

// router.refresh() every 15 s while this page is visible. It keeps client state (the filter, an open menu) and waits
// while a dialog or menu holds the page (the same hold the 60 s refresh uses), so nothing changes under a form. A new
// request is never sent over one that is still on its way. Coming back to the tab refreshes once at once.
export function AgentsRefresh() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const pendingRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    const tick = () => {
      if (pendingRef.current) return;
      if (agentsRefreshDue({ visible: document.visibilityState === "visible", online: navigator.onLine !== false, held: holdCount() > 0 })) {
        start(() => router.refresh());
      }
    };
    const timer = setInterval(tick, AGENTS_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);
  return null;
}
