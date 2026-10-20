import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 1.1: lib/time.ts is the only place that knows the time zone. Code anywhere else in app/src that writes "WIB", names
// Asia/Jakarta, adds a fixed +7 h, formats a date without a zone (the server's or the browser's own zone would show,
// and SSR and hydration would differ) or reads the zone at module load (the browser doesn't know it yet then) would
// show or schedule the wrong time once WATCHBELL_TIMEZONE is set. Comments may still say WIB. Left out: tests, the
// owner-only office (excluded from the public edition, still on WIB) and database migrations.
const SRC = fileURLToPath(new URL("..", import.meta.url));

const ZONE_HELPERS = "timeZone|zoneName|zoneLabel|zoneSentence|clock|clockSeconds|dayKey|dayStart|dayMonth|calendarDate|zonedParts|dailyRunText|vercelCronText|toLocalInput|zonedFormat";
const RULES: [(code: string) => boolean, string][] = [
  [(c) => /\bWIB\b/.test(c), "WIB"],
  [(c) => /Asia\/Jakarta/.test(c), "Asia/Jakarta"],
  [(c) => /\+07:00/.test(c), "+07:00"],
  [(c) => /\b7\s*\*\s*(3_?600_?000|60\s*\*\s*60\s*\*\s*1000|H|HOUR)\b|\b25_?200_?000\b|\bWIB_MS\b/.test(c), "fixed +7 h"],
  [(c) => /\.toLocale(Date|Time)String\(/.test(c) && !/timeZone/.test(c), "toLocale…String without timeZone"],
  [(c) => /\.toLocaleString\([^)]*(dateStyle|timeStyle|hour|minute|month|weekday)/.test(c) && !/timeZone/.test(c), "toLocaleString of a date without timeZone"],
  [(c) => /new Intl\.DateTimeFormat\(/.test(c) && !/timeZone/.test(c), "Intl.DateTimeFormat without timeZone"],
  // A module-level constant computed from the zone (a function body or an arrow is fine: it runs when called).
  [(c) => new RegExp(`^(export )?(const|let|var) [^=]+=(?:(?!=>).)*\\b(${ZONE_HELPERS})\\(`).test(c), "zone read at module load"],
];

const skipped = (rel: string) =>
  rel === "lib/time.ts" || /\.test\.tsx?$/.test(rel) || rel.startsWith("private/office/") || rel.split("/").includes("migrations");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mts)$/.test(e.name) ? [p] : [];
  });
}

// The code on a line, without its comment: whole-line comments go, as do a trailing "// …" and inline {/* … */}.
function code(line: string): string {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return "";
  return line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/\s\/\/\s.*$/, "");
}

const broken = (line: string): string[] => RULES.filter(([test]) => test(code(line))).map(([, what]) => what);

function offenders(): string[] {
  const out: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split(sep).join("/");
    if (skipped(rel)) continue;
    readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      for (const what of broken(line)) out.push(`${rel}:${i + 1} ${what}`);
    });
  }
  return out;
}

describe("time zone literals (1.1)", () => {
  it("only lib/time.ts knows the zone: no WIB, Asia/Jakarta, +7 h, zone-less date formatting or zone read at load", () => {
    expect(offenders()).toEqual([]);
  });

  it("would catch one", () => {
    expect(broken('  const s = `${clock(d)} WIB`;')).toEqual(["WIB"]);
    expect(broken('  x.toLocaleString("en-GB", { timeZone: "Asia/Jakarta" }); // in WIB')).toEqual(["Asia/Jakarta"]);
    expect(broken("  // 03:00 WIB is 20:00 UTC")).toEqual([]);
    expect(broken("  const DAILY = 20; // 03:00 WIB")).toEqual([]);
    expect(broken("  const wib = new Date(now.getTime() + 7 * 3_600_000);")).toEqual(["fixed +7 h"]);
    expect(broken('  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });')).toEqual(["toLocale…String without timeZone"]);
    expect(broken('  {new Date(x).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}')).toEqual(["toLocaleString of a date without timeZone"]);
    expect(broken("  n.toLocaleString()")).toEqual([]);
    expect(broken('const f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit" });')).toEqual(["Intl.DateTimeFormat without timeZone"]);
    expect(broken("export const HEADER = `Time (${zoneName()})`;")).toEqual(["zone read at module load"]);
    expect(broken("export const header = () => `Time (${zoneName()})`;")).toEqual([]);
  });
});
