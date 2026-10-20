"use client";

import { useEffect, useRef, useState } from "react";

type TurnstileApi = { render: (el: HTMLElement, opts: Record<string, unknown>) => string; remove: (id: string) => void };
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    const el = script;
    el.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"))));
    // A failed script never fires again, so drop it: the next mount (the form re-mounts after each submit) retries.
    el.addEventListener("error", () => {
      el.remove();
      reject(new Error("turnstile"));
    });
  });
}

// Renders inside a <form>; Turnstile adds a hidden "cf-turnstile-response" input that the Server Action reads.
// Tokens are single-use, so the form re-mounts this component (new key) after every submit.
export function Turnstile({ siteKey }: { siteKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (!cancelled && ref.current) widgetId = api.render(ref.current, { sitekey: siteKey, action: "signin", theme: "auto" });
      })
      .catch(() => {
        console.warn("bot check failed to load");
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey]);
  if (failed) {
    return <p role="alert" className="mb-3.5 text-[13px] text-err">The bot check couldn&apos;t load. Check your connection and reload the page.</p>;
  }
  return <div ref={ref} className="mb-3.5 min-h-[65px]" />;
}
