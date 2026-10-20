// U6/U7 and B1: what a stranger may see. Words, numbers and colours only: the page title and announcement, each chosen
// monitor's public name (typed by the owner) and badge key, a state word, 90-day bars and uptime %, and maintenance
// times and notes. Never a URL, host, path, status code, error text, provider name, app name or id.
import { isUuid } from "@/lib/ids";
import type { State } from "@/lib/status";

export type PublicState = "ok" | "warn" | "err" | "maint" | "unknown";

// B5: one status page with at most 30 monitors.
export const MAX_ON_PAGE = 30;
export const TITLE_MAX = 80;
export const ANNOUNCEMENT_MAX = 200;
export const NAME_MAX = 60;

const SLUG = /^[a-z0-9-]{3,40}$/;

export function parseSlug(v: unknown): string | null {
  return typeof v === "string" && SLUG.test(v) ? v : null;
}

// "Wedding site" → "wedding-site": the badge's file name, from the public name only.
export function badgeKey(name: string): string {
  const k = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  return k || "monitor";
}

// Paused, unwatched or never checked reads "No data": the public page doesn't explain why.
export function publicState(s: State, inMaintenance: boolean, paused: boolean): { state: PublicState; label: string } {
  if (paused) return { state: "unknown", label: "No data" };
  if (inMaintenance) return { state: "maint", label: "Maintenance" };
  if (s === "ok") return { state: "ok", label: "Operational" };
  if (s === "warn") return { state: "warn", label: "Degraded" };
  if (s === "err") return { state: "err", label: "Down" };
  return { state: "unknown", label: "No data" };
}

// The console's light-theme state colours, dark enough for white 11 px text (≥ 4.5:1).
const COLOR: Record<PublicState, string> = { ok: "#17773f", warn: "#8f5200", err: "#c0272d", maint: "#1f45c9", unknown: "#5f6670" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const width = (s: string) => Math.round(s.length * 6.6) + 12; // Verdana 11 px, close enough for short words

// Shields-style flat badge: two rects and two texts. No external fonts, images, links or scripts.
export function badgeSvg(label: string, value: string, tone: PublicState): string {
  const rawL = label.slice(0, 30);
  const rawV = value.slice(0, 30);
  const l = esc(rawL);
  const v = esc(rawV);
  const lw = width(rawL);
  const vw = width(rawV);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${l}: ${v}"><title>${l}: ${v}</title>`
    + `<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${COLOR[tone]}"/>`
    + `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="14">${l}</text><text x="${lw + 6}" y="14">${v}</text></g></svg>`;
}

export type StatusPageValue = {
  slug: string; title: string; announcement: string | null; published: boolean;
  monitors: { monitorId: string; displayName: string; position: number }[];
};

export function parseStatusPageForm(f: unknown): { ok: true; value: StatusPageValue } | { ok: false; fieldErrors: Record<string, string> } {
  const o = (f && typeof f === "object" && !Array.isArray(f) ? f : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const slug = parseSlug(o.slug);
  if (!slug) errors.slug = "Use 3–40 lowercase letters, digits or dashes.";
  const title = (typeof o.title === "string" ? o.title : "").trim().slice(0, TITLE_MAX);
  if (!title) errors.title = "Give the page a title.";
  const announcement = (typeof o.announcement === "string" ? o.announcement : "").trim().slice(0, ANNOUNCEMENT_MAX) || null;
  const raw = Array.isArray(o.monitors) ? o.monitors : o.monitors === undefined ? [] : null;
  const monitors = (raw ?? []).map((m, i) => {
    const x = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    return { monitorId: typeof x.monitorId === "string" ? x.monitorId : "", displayName: (typeof x.displayName === "string" ? x.displayName : "").trim().slice(0, NAME_MAX), position: i };
  });
  if (!raw || monitors.some((m) => !isUuid(m.monitorId) || !m.displayName)) errors.monitors = "Every monitor needs a public name.";
  else if (monitors.length > MAX_ON_PAGE) errors.monitors = `A status page can show at most ${MAX_ON_PAGE} monitors.`;
  else if (new Set(monitors.map((m) => m.monitorId)).size !== monitors.length) errors.monitors = "A monitor can be on the page only once.";
  else if (new Set(monitors.map((m) => badgeKey(m.displayName))).size !== monitors.length) errors.monitors = "Two monitors can't share a public name.";
  if (Object.keys(errors).length || !slug) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { slug, title, announcement, published: o.published === true, monitors } };
}
