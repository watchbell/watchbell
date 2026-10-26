"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  isIdle, liveText, parseRefreshChoice, REFRESH_CHOICE_KEY, REFRESH_CHOICES, type RefreshChoice, refreshDue, refreshOnReturn,
} from "@/lib/view/refresh";

// R1. One polling page at a time. This store remembers when that page's data last arrived (client clock), whether the
// tab is idle, and how many dialogs or menus are holding the refresh, so the top bar can say "Updated Ns ago" and an
// open form isn't re-rendered under the person using it. router.refresh() keeps client state; holding avoids a row
// (and the dialog opened from it) changing or disappearing mid-edit.
let lastAt: number | null = null;
let idle = false;
let holds = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const getLast = () => lastAt;
const getIdle = () => idle;
const getServerLast = () => null;
const getServerIdle = () => false;

// The store changes only through these module functions, never by reassigning from inside a component.
function markUpdated(at: number | null) {
  lastAt = at;
  emit();
}
function markIdle(next: boolean) {
  if (idle === next) return;
  idle = next;
  emit();
}

// 1.2.3: the refresh picker (per browser, localStorage; `memory` keeps a choice for this visit when storage is
// blocked) and the collector's last run, which the sidebar's status poll reports, so Auto refreshes after each run.
let memoryChoice: RefreshChoice | null = null;
let collectorRunAt: number | null = null;
const getChoice = (): RefreshChoice => {
  if (memoryChoice) return memoryChoice;
  try {
    return parseRefreshChoice(localStorage.getItem(REFRESH_CHOICE_KEY));
  } catch {
    return "auto";
  }
};
const getServerChoice = (): RefreshChoice => "auto";
export function setRefreshChoice(next: RefreshChoice) {
  memoryChoice = next;
  try {
    localStorage.setItem(REFRESH_CHOICE_KEY, next);
  } catch {
    // Storage blocked: the choice still holds for this visit.
  }
  emit();
}
export function markCollectorRun(at: number | null) {
  if (collectorRunAt === at) return;
  collectorRunAt = at;
  emit();
}

// How many holds are active (for tests).
export const holdCount = () => holds;

export function holdRefresh(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

// What useHoldRefresh's effect does: a hold only while `active` is true, so a closed dialog or menu holds nothing.
export function holdWhile(active: boolean): (() => void) | undefined {
  return active === true ? holdRefresh() : undefined;
}

// For dialogs and menus: holds the page's refresh while `active` is true.
export function useHoldRefresh(active: boolean) {
  useEffect(() => holdWhile(active), [active]);
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

// Put on a polling page with the server's render time. Each refresh renders a new `at`, which marks the data fresh.
// The refresh runs in a transition, so `pending` says when it is still on its way: a new one is never sent over it
// (refreshDue), which a page whose render is slower than the period needs to update at all.
// `everyMs` shortens the period while the page waits on something quick (AI › Ask: 15 s while a question is pending);
// holds, hidden tabs, offline and idle still apply. Leave it out for the normal 60 s.
export function AutoRefresh({ at, everyMs }: { at: number; everyMs?: number }) {
  const router = useRouter();
  const everyRef = useRef(everyMs);
  useEffect(() => {
    everyRef.current = everyMs;
  }, [everyMs]);
  const [pending, startRefresh] = useTransition();
  const pendingRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    markUpdated(Date.now());
  }, [at]);
  useEffect(() => {
    let requestedAt = 0;
    let lastInputAt = Date.now();
    const state = () => ({
      visible: document.visibilityState === "visible",
      held: holds > 0,
      online: navigator.onLine !== false,
      pending: pendingRef.current,
      lastAt: lastAt ?? 0,
      requestedAt,
      period: everyRef.current,
      choice: getChoice(),
      collectorRunAt,
    });
    const refresh = (now: number) => {
      requestedAt = now;
      startRefresh(() => router.refresh());
    };
    const tick = () => {
      const now = Date.now();
      markIdle(isIdle(lastInputAt, now));
      if (refreshDue({ ...state(), lastInputAt, now })) refresh(now);
    };
    // Back to the tab, or back online: refresh once, right away.
    const onReturn = () => {
      if (refreshOnReturn(state())) refresh(Date.now());
    };
    const onInput = () => {
      const now = Date.now();
      const wasIdle = isIdle(lastInputAt, now);
      lastInputAt = now;
      if (wasIdle) tick(); // back to every 60 s at once
    };
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("online", onReturn);
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true });
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("online", onReturn);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput);
      markIdle(false);
      markUpdated(null);
    };
  }, [router]);
  return null;
}

// Top bar (mockup section 8): a dot + "Updated Ns ago · Auto · after each check", which opens the refresh picker.
// Hidden on pages that don't poll and below 720 px.
export function LiveIndicator() {
  const last = useSyncExternalStore(subscribe, getLast, getServerLast);
  const slow = useSyncExternalStore(subscribe, getIdle, getServerIdle);
  const choice = useSyncExternalStore(subscribe, getChoice, getServerChoice);
  const [now, setNow] = useState(0);
  const polling = last !== null;
  // Tick only while a page is polling. A stale `now` from before the last update never shows: max() seeds it with `last`.
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [polling]);
  if (last === null) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Refresh: choose how often this page updates"
        className="mr-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1 text-[12.5px] text-ink-soft hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-[720px]:hidden"
      >
        <span className={choice === "off" ? "size-2 rounded-full bg-idle" : "size-2 rounded-full bg-ok"} aria-hidden />
        <span aria-live="off">{liveText(last, Math.max(now, last), slow, choice)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-ink-faint">Refresh this page</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setRefreshChoice(parseRefreshChoice(String(v)))}>
            {REFRESH_CHOICES.map((c) => <DropdownMenuRadioItem key={c.id} value={c.id}>{c.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
