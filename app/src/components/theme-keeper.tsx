"use client";

import { useLayoutEffect } from "react";
import { missingTheme, THEME_KEY } from "@/lib/theme";

function restoreTheme() {
  const root = document.documentElement;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage can be blocked (private windows): fall back to the system preference.
  }
  const next = missingTheme(root.dataset.theme, stored, window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (next) root.dataset.theme = next;
}

// Keeps <html data-theme> set (J2). The init script sets it before first paint, but React removes all of <html>'s
// attributes whenever it renders the root on the client instead of hydrating it: an app's 404 rendered by the
// not-found boundary, an error page, or a hydration mismatch. This runs after every such render (it is remounted with
// the root, and a layout effect runs before paint) and also watches the attribute, so the page never drops to light.
export function ThemeKeeper() {
  useLayoutEffect(() => {
    restoreTheme();
    const observer = new MutationObserver(restoreTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return null;
}
