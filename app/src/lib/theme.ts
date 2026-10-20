export const THEME_KEY = "oc-theme";
export type Theme = "light" | "dark";

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

// Runs before first paint so the page never flashes the wrong theme.
export const themeInitScript = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_KEY)});var d=window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.dataset.theme=(s==="light"||s==="dark")?s:(d?"dark":"light");}catch(e){document.documentElement.dataset.theme="light";}})();`;

// The theme <html data-theme> needs, or null when it already has one. React drops every attribute of <html> when it
// renders the root afresh on the client (a not-found or error page whose tree differs from the server's, or a failed
// hydration), and the init script doesn't run again then, so ThemeKeeper puts the attribute back (J2).
export function missingTheme(current: string | undefined, stored: string | null, prefersDark: boolean): Theme | null {
  return current === "light" || current === "dark" ? null : resolveTheme(stored, prefersDark);
}
