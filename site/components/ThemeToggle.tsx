"use client";

import { THEME_KEY } from "@/lib/theme";

// The console's toggle: one icon button, a moon while the page is light and a sun while it is dark. It flips whatever is
// showing now (the stored choice, else the system setting) and remembers it. Both icons are in the HTML and the
// stylesheet shows the right one, so the server render never disagrees with the theme the init script picked.
export function ThemeToggle({ label }: { label: string }) {
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
    <button type="button" className="iconbtn themebtn" onClick={toggle} aria-label={label} title={label}>
      <svg className="moon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />
      </svg>
      <svg className="sun" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
        <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />
      </svg>
    </button>
  );
}
