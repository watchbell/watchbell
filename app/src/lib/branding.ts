// Watchbell 1.7 (spec §2.5, §7): one brand per install — the name, logo, accent colour, email sender name and public
// address the client sees. The logo bytes live apart (lib/data/branding-db.ts) so pages read only `hasLogo`.
// What stays "Watchbell": the CLI, docs links, the version label, logs.

export type Brand = {
  name: string | null;
  accent: string | null; // #rrggbb
  senderName: string | null;
  publicUrl: string | null;
  poweredBy: boolean;
  hasLogo: boolean;
};

export const DEFAULT_BRAND: Brand = { name: null, accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: false };

export const BRAND_SETTING = "branding";
export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MAX_PX = 512;
// The console's own surfaces (globals.css): text on white must reach 4.5:1, a colour on the dark surface 3:1.
const LIGHT_BG = "#ffffff";
const DARK_BG = "#111214";

const HEX = /^#[0-9a-f]{6}$/;

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a.toLowerCase()), luminance(b.toLowerCase())].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export const displayName = (b: Brand): string => b.name ?? "Watchbell";

// A From header: one word goes bare, anything else is quoted (no quotes or line breaks can get in).
export function mailFrom(name: string | null, address: string): string {
  const n = (name ?? "Watchbell").replace(/["\r\n<>]/g, "").trim() || "Watchbell";
  return /^[\w.-]+$/.test(n) ? `${n} <${address}>` : `"${n}" <${address}>`;
}

// The brand only names the sender; the address stays the mail channel's (servers refuse others).
export const senderFrom = (b: Brand, address: string): string => mailFrom(b.senderName, address);

// "Watchbell <a@b.c>" or "a@b.c" → "a@b.c" (DIGEST_FROM may carry a name already).
export const addressOf = (from: string): string => /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim();

export function brandProblems(b: Brand): Record<string, string> {
  const e: Record<string, string> = {};
  if (b.name !== null && (b.name.length > 60 || /[<>\r\n]/.test(b.name))) e.name = "Up to 60 characters, no < or >.";
  if (b.senderName !== null && (b.senderName.length > 60 || /[<>"\r\n]/.test(b.senderName))) e.senderName = "Up to 60 characters, no <, > or quotes.";
  if (b.publicUrl !== null) {
    let ok = false;
    try {
      const u = new URL(b.publicUrl);
      ok = u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
    } catch {
      ok = false;
    }
    if (!ok) e.publicUrl = "An https:// address (http:// only for localhost).";
  }
  if (b.accent !== null) {
    if (!HEX.test(b.accent)) e.accent = "A colour as #rrggbb.";
    else if (contrastRatio(b.accent, LIGHT_BG) < 4.5) e.accent = `Too pale to read on the light background (${contrastRatio(b.accent, LIGHT_BG).toFixed(1)}:1, needs 4.5:1).`;
    else if (contrastRatio(b.accent, DARK_BG) < 3) e.accent = `Too dark to see on the dark background (${contrastRatio(b.accent, DARK_BG).toFixed(1)}:1, needs 3:1).`;
  }
  return e;
}

// PNG only (pdf-lib embeds PNG, and an SVG could carry script): square within 10%, at most 512 px and 256 KB.
export function logoProblem(bytes: Uint8Array): string | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((v, i) => bytes[i] !== v)) return "The logo must be a PNG file.";
  if (bytes.length > LOGO_MAX_BYTES) return "The logo must be 256 KB or smaller.";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  if (!w || !h || Math.abs(w - h) / Math.max(w, h) > 0.1) return "The logo must be square (or nearly).";
  if (Math.max(w, h) > LOGO_MAX_PX) return `The logo can be at most ${LOGO_MAX_PX} × ${LOGO_MAX_PX} px.`;
  return null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// The settings form: blank means the default; the URL loses a trailing slash; the colour is lower-cased.
export function parseBrandForm(f: Record<string, unknown>): { ok: true; value: Brand } | { ok: false; fieldErrors: Record<string, string> } {
  const url = text(f.publicUrl);
  const value: Brand = {
    name: text(f.name),
    accent: text(f.accent)?.toLowerCase() ?? null,
    senderName: text(f.senderName),
    publicUrl: url ? url.replace(/\/+$/, "") : null,
    poweredBy: f.poweredBy === "on" || f.poweredBy === true || f.poweredBy === "true",
    hasLogo: false,
  };
  const fieldErrors = brandProblems(value);
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, value };
}

// A stored row, read leniently: anything odd falls back to the default for that field.
export function parseBrand(v: unknown): Brand {
  if (!v || typeof v !== "object") return { ...DEFAULT_BRAND };
  const o = v as Record<string, unknown>;
  const b: Brand = {
    name: text(o.name), accent: typeof o.accent === "string" && HEX.test(o.accent) ? o.accent : null, senderName: text(o.senderName),
    publicUrl: text(o.publicUrl), poweredBy: o.poweredBy !== false, hasLogo: o.hasLogo === true,
  };
  const bad = brandProblems(b);
  for (const k of Object.keys(bad)) (b as Record<string, unknown>)[k] = null;
  return b;
}

// The accent as CSS for the console's tokens (globals.css), in light and dark alike: text on the accent is white (the
// accent passed 4.5:1 against white). Doubled :root outranks the theme rules. Null without an accent.
export function brandStyle(b: Brand): string | null {
  if (!b.accent || !HEX.test(b.accent)) return null;
  return `:root:root, :root:root[data-theme="dark"] { --oc-brand: ${b.accent}; --oc-brand-hover: ${b.accent}; --oc-on-brand: #ffffff; }`;
}

// The console's tab title and icon (the (console) layout's metadata). Nothing without a brand name, so the root
// layout's "Watchbell" and its icon stay.
export function consoleMetadata(b: Brand): { title?: { default: string; template: string }; icons?: { icon: string } } {
  if (!b.name) return {};
  return { title: { default: b.name, template: `%s · ${b.name}` }, ...(b.hasLogo ? { icons: { icon: "/brand-icon" } } : {}) };
}

// Review I-7: checked in the browser before upload (the server action never sees a body over Next's 1 MB limit, so a
// big file would fail without a reason). No file chosen: nothing to say.
export function logoFileProblem(f: { size: number; type: string }): string | null {
  if (!f.size) return null;
  if (f.type !== "image/png") return "The logo must be a PNG file.";
  if (f.size > LOGO_MAX_BYTES) return "The logo must be 256 KB or smaller.";
  return null;
}
