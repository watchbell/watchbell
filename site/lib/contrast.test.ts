// WCAG AA contrast of the site's text colours, in both themes, computed from the tokens in app/styles.css.
// Normal text needs 4.5:1. Every `color: var(--token)` in the stylesheet must be a token checked here, or a
// decoration / large-text use listed in DECORATIVE, so a new rule can't quietly use a faint colour for text.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cssFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "styles.css");
const css = fs.readFileSync(cssFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Tokens = Record<string, string>;

/** The custom properties declared in the first block whose selector is exactly `selector`. */
function tokensOf(selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`${selector} not found in app/styles.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const tokens: Tokens = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return tokens;
}

const light = tokensOf(":root");
const darkOverrides = tokensOf(':root[data-theme="dark"]');
const themes: Record<string, Tokens> = { light, dark: { ...light, ...darkOverrides } };

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`can't read the colour "${value}"`);
}

/** A token's colour in a theme; a translucent one is laid over `under` (the colour it sits on in the page). */
function colour(theme: Tokens, token: string, under?: string): [number, number, number] {
  const value = theme[token];
  if (value === undefined) throw new Error(`--${token} is not defined`);
  const [r, g, b, a] = parseColor(value);
  if (a === 1) return [r, g, b];
  if (!under) throw new Error(`--${token} is translucent; say what it sits on`);
  const base = colour(theme, under);
  return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour → the backgrounds it is used on ("kb-bg over tg-bg": a translucent background on the one below it). */
const TEXT: Record<string, string[]> = {
  ink: ["bg", "paper", "surface", "sunken", "hover", "tg-in", "tg-out", "tg-bg"],
  "ink-soft": ["bg", "paper", "surface", "sunken", "hover"],
  "ink-mute": ["bg", "paper", "surface", "sunken", "tg-in", "tg-out"],
  brand: ["bg", "paper", "surface", "sunken", "brand-soft", "tg-in", "tg-out", "kb-bg over tg-bg"],
  "brand-hover": ["bg", "paper", "surface"],
  ok: ["bg", "paper", "surface", "tg-in", "tg-out"],
  warn: ["bg", "paper", "surface"],
  err: ["bg", "paper", "surface", "tg-in", "tg-out"],
  "on-brand": ["brand"],
  // Inverted: the primary button, the WB mark and the skip link.
  bg: ["ink"],
  "night-ink": ["night", "night-2"],
  "night-soft": ["night", "night-2"],
  "night-mute": ["night", "night-2"],
  "night-brand": ["night", "night-2"],
  "night-ok": ["night", "night-2"],
  "night-err": ["night", "night-2"],
};

/** Faint colours that are allowed because they aren't body-size text. Large text (≥ 24 px) needs 3:1. */
const DECORATIVE: Record<string, { token: string; large?: string }> = {
  ".lang .sep": { token: "ink-faint" }, // the "/" between EN and ID, aria-hidden
  ".home h1 span": { token: "ink-faint", large: "bg" }, // the second line of the 40–66 px headline
  ".fine summary::after": { token: "ink-faint" }, // the "+" / "–" marker
  ".docs-menu summary::after": { token: "ink-faint" },
  ".doc .anchor": { token: "ink-faint" }, // the "#" heading link, aria-hidden and shown on hover only
};

describe("text contrast (WCAG AA)", () => {
  it("defines the same dark colours for the toggle and for the system setting", () => {
    expect(tokensOf(':root:not([data-theme="light"])')).toEqual(darkOverrides);
  });

  for (const [name, theme] of Object.entries(themes)) {
    it(`reaches 4.5:1 for every text colour on its backgrounds (${name})`, () => {
      const failures: string[] = [];
      for (const [text, backgrounds] of Object.entries(TEXT)) {
        for (const bg of backgrounds) {
          const [token, under] = bg.split(" over ");
          const ratio = contrast(colour(theme, text), colour(theme, token, under));
          if (ratio < 4.5) failures.push(`--${text} on --${bg}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`reaches 3:1 for large faint text (${name})`, () => {
      for (const [selector, { token, large }] of Object.entries(DECORATIVE)) {
        if (!large) continue;
        expect(contrast(colour(theme, token), colour(theme, large)), selector).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("uses only checked text colours in the stylesheet", () => {
    const unchecked: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].trim().split(/\s*,\s*/);
      for (const decl of rule[2].matchAll(/(?:^|[;\s])color\s*:\s*var\(--([\w-]+)\)/g)) {
        const token = decl[1];
        if (token in TEXT) continue;
        const ok = selectors.every((s) => DECORATIVE[s]?.token === token);
        if (!ok) unchecked.push(`${selectors.join(", ")} { color: var(--${token}) }`);
      }
    }
    expect(unchecked).toEqual([]);
  });
});
