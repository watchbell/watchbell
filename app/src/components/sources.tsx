"use client";

import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";

const KEY = "oc-src";

// The flag lives in localStorage. A tiny external store lets React read it without
// mirroring it in state (setState inside an effect is rejected by the lint rules).
// `memory` keeps the toggle working for this visit when storage is blocked.
let memory: boolean | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getShow(): boolean {
  if (memory !== null) return memory;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function getServerShow(): boolean {
  return false;
}

function setShow(next: boolean) {
  memory = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "");
  } catch {
    // Storage blocked: the toggle still works for this visit.
  }
  listeners.forEach((l) => l());
}

const Ctx = createContext<{ show: boolean; toggle: () => void }>({ show: false, toggle: () => {} });

export function SourcesProvider({ children }: { children: ReactNode }) {
  const show = useSyncExternalStore(subscribe, getShow, getServerShow);

  useEffect(() => {
    document.body.classList.toggle("show-src", show);
  }, [show]);

  return <Ctx.Provider value={{ show, toggle: () => setShow(!getShow()) }}>{children}</Ctx.Provider>;
}

export const useSources = () => useContext(Ctx);

const SRC_TEXT = { api: "API", own: "Own check", calc: "Computed", test: "Needs test" } as const;

export function Src({ kind, children }: { kind: keyof typeof SRC_TEXT; children?: ReactNode }) {
  return <span className={`src src-${kind}`}>{children ?? SRC_TEXT[kind]}</span>;
}
