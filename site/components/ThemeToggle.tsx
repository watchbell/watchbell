"use client";

import { THEME_KEY } from "@/lib/theme";

// The mockup's toggle: flips whatever is showing now (the stored choice, else the system setting) and remembers it.
// Its accessible name is the visible text ("dark / light"), so voice control finds it; `title` explains it on hover.
export function ThemeToggle({ label, title }: { label: string; title: string }) {
  function toggle() {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private window or blocked storage: the toggle still works for this page.
    }
  }
  return (
    <button type="button" className="themebtn" onClick={toggle} title={title}>
      {label}
    </button>
  );
}
