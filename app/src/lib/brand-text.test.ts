import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The product is called Watchbell (20 Oct 2026; WATCHPOST is someone else's trademark). This test reads every string a
// person can see in app/src — string literals, template text and JSX text, not comments, identifiers or regex literals —
// and fails on any "Watchpost" left over, except the identifiers kept on purpose because renaming them would sign the
// owner out, orphan stored data or break something already running.
const KEPT: { re: RegExp; why: string; file?: string }[] = [
  { re: /\.watchpost\.lock/g, why: "PGlite lock file name in an existing data folder" },
  { re: /watchpost\.(?:sql\.snippets|explorer\.examples)\.v1/g, why: "browser storage keys holding the owner's snippets and examples" },
  { re: /watchpost:(?:explorer-examples|demo-cookie:v1|telegram-callback:v1|telegram-link:)/g, why: "HMAC labels and an in-page event: live cookies, Telegram buttons and link codes" },
  { re: /\$watchpost\$|watchpost_ro_read|watchpost_ro|watchpost_probe/g, why: "the read-only role already created in the owner's databases (stored DSNs), its policy and probe names" },
  { re: /watchpost\/deps-|watchpost-lockfile/g, why: "update-PR branch prefix (open PRs, the VM runner) and the dispatch event the owner's actions repo listens for" },
  { re: /watchpost-console/g, why: "ai_agents client_name, the conflict key of the console's own agent row" },
  { re: /watchpost-runner/g, why: "pm2 process and folder of the VM runner already installed on the owner's VM (private edition)" },
  { re: /^Watchpost backups$/g, why: "the Drive folder made before the rename, found by name if its stored id is lost", file: "src/lib/backup/content.ts" },
  { re: /^watchpost$/g, why: "the client id stored on AI notes and answers" },
  { re: /^WATCHPOST_$/g, why: "the legacy env prefix read as a fallback", file: "src/lib/brand-env.ts" },
  { re: /Watchpost console/g, why: "renames the console agent row stored before the rename", file: "src/private/ai/usage.ts" },
  { re: /watchpost\[bot\]|watchpost-bot@users\.noreply\.github\.com|update package-lock\.json \(Watchpost\)/g, why: "the lockfile commit of the pre-rename workflow still running in owners' actions repos, accepted by the merge watcher", file: "src/lib/deps/pr-watch.ts" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// Every piece of text in a file that ends up as a value: strings, template parts, JSX text.
function visibleTexts(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    else if (ts.isJsxText(n)) out.push(n.text);
    // Module specifiers and property names that are identifiers are not text a person sees; string ones are kept above.
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

const root = resolve("src");

function leftovers(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(root)) {
    const rel = relative(resolve("."), file).replace(/\\/g, "/");
    for (const text of visibleTexts(file)) {
      if (!/watchpost/i.test(text)) continue;
      let rest = text;
      for (const k of KEPT) if (!k.file || k.file === rel) rest = rest.replace(k.re, "");
      if (/watchpost/i.test(rest)) found.push(`${rel}: ${text.trim().slice(0, 120)}`);
    }
  }
  return found;
}

describe("brand: Watchbell", () => {
  it("no user-visible string in app/src still says Watchpost (kept identifiers aside)", () => {
    expect(leftovers()).toEqual([]);
  });
  it("finds a leftover in a string but not in a comment or an identifier", () => {
    const texts = visibleTexts(join(root, "lib", "brand-env.ts"));
    expect(texts).toContain("WATCHPOST_");
    expect(texts.join(" ")).not.toContain("The product was called");
  });
});
