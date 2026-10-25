// WCAG AA (4.5:1) for the console's text greys, in both themes, read from the tokens in globals.css.
// `text-ink-faint` is used for crumbs, table secondary text and footnotes at 12–13 px, so it must pass too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");

function tokensOf(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`${selector} not found in globals.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--oc-([\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokensOf(":root");
const themes = { light, dark: { ...light, ...tokensOf(':root[data-theme="dark"]') } };

describe("console text greys", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const ink of ["ink", "ink-soft", "ink-faint"]) {
      for (const surface of ["bg", "surface", "surface-2", "sunken", "hover"]) {
        it(`${name}: ${ink} on ${surface} is at least 4.5:1`, () => {
          expect(ratio(t[ink], t[surface])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
