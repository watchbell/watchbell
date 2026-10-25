// Checks that the documentation matches the code it describes: every relative link (and #anchor) resolves, every
// installer option the docs use exists (in the installers' interface and, once the installers are there, in their
// --help text), every `npm run <script>` exists in app/package.json, every localhost port is the default or one the
// same page sets, and (in the private source tree only) no owner identifier from the export deny-list appears. The
// Indonesian pages (docs/id/) get the same checks, and each one must mirror its English original: same file name,
// same heading outline (so the site can map a section to its twin by position), the same link destinations, and a
// link to the other language at the top.
//
// Runs from both layouts: the private tree (this file in public-edition/tests, the app in ../app) and the exported
// public repository (this file in tests/, the app in app/). Node built-ins only: node --test tests/docs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_DOCS = [
  "README.md", "install.md", "first-run.md", "pages.md", "providers.md", "notifications.md", "auto-actions.md", "ai.md",
  "backups.md", "sql-console.md", "troubleshooting.md", "faq.md", "configuration.md",
];
const ROOT_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "app/README.md"];

// The installers' interface (plan 6, Tasks 2 and 3). install.bat forwards its arguments to install.ps1, which accepts
// both spellings. The uninstallers take only --yes and --help (-Yes and -Help on Windows).
const SH_FLAGS = ["--yes", "--no-service", "--port", "--upgrade", "--help"];
const PS_FLAGS = ["-Yes", "-NoService", "-Port", "-Upgrade", "-Help"];
const ALLOWED = {
  "install.sh": SH_FLAGS,
  "install.bat": [...SH_FLAGS, ...PS_FLAGS],
  "install.ps1": [...SH_FLAGS, ...PS_FLAGS],
  "uninstall.sh": ["--yes", "--help"],
  "uninstall.bat": ["--yes", "--help", "-Yes", "-Help"],
  "uninstall.ps1": ["--yes", "--help", "-Yes", "-Help"],
};
const DEFAULT_PORT = "3100";

// Markdown pages of one docs folder (none if the folder isn't there).
const pagesIn = (dir) =>
  fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".md")).sort() : [];
const EN = "docs";
const ID = "docs/id";
const docFiles = () => [
  ...pagesIn(EN).map((f) => `${EN}/${f}`),
  ...pagesIn(ID).map((f) => `${ID}/${f}`),
  ...ROOT_FILES.filter((f) => fs.existsSync(path.join(root, f))),
];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// Markdown without fenced code blocks (links and headings inside them are not links or headings).
function withoutFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push("");
    } else if (m) {
      fence = m[1];
      out.push("");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// The headings in order, each with its level and GitHub's anchor: lower case, punctuation dropped (letters, digits,
// spaces, "-" and "_" kept), spaces to "-", repeats numbered -1, -2 …
export function headingsOf(markdown) {
  const seen = new Map();
  const headings = [];
  for (const line of withoutFences(markdown).split("\n")) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const text = h[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    headings.push({ level: h[1].length, anchor: n === 0 ? base : `${base}-${n}` });
  }
  return headings;
}

export function anchorsOf(markdown) {
  return new Set(headingsOf(markdown).map((h) => h.anchor));
}

// A page's link targets: Markdown links and images, and the HTML ones (<img src>, <source srcset>, <a href>) the
// README uses. Code, fenced or inline, holds no links.
function linkTargets(rel) {
  const text = withoutFences(read(rel)).replace(/`[^`\n]*`/g, "");
  const targets = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  for (const m of text.matchAll(/\b(src|srcset|href)="([^"]+)"/g)) {
    if (m[1] === "srcset") targets.push(...m[2].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean));
    else targets.push(m[2]);
  }
  return targets;
}

const isExternal = (target) => /^(https?:|mailto:)/i.test(target);
const resolveTarget = (rel, file) =>
  file === "" ? path.join(root, rel) : path.resolve(path.dirname(path.join(root, rel)), decodeURI(file));

function appPackage() {
  for (const candidate of [path.join(root, "app", "package.json"), path.join(root, "..", "app", "package.json")]) {
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8"));
  }
  throw new Error("app/package.json not found next to the docs or one folder up");
}

test("every documentation page exists", () => {
  for (const f of REQUIRED_DOCS) assert.ok(fs.existsSync(path.join(root, "docs", f)), `docs/${f} is missing`);
  for (const f of ROOT_FILES) assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
});

test("every relative link and anchor resolves", () => {
  const problems = [];
  for (const rel of docFiles()) {
    for (const target of linkTargets(rel)) {
      if (isExternal(target)) continue;
      const [file, anchor] = target.split("#");
      const abs = resolveTarget(rel, file);
      if (!fs.existsSync(abs)) {
        problems.push(`${rel}: ${target} (no such file)`);
        continue;
      }
      if (anchor !== undefined && abs.endsWith(".md") && !anchorsOf(fs.readFileSync(abs, "utf8")).has(anchor)) {
        problems.push(`${rel}: ${target} (no such heading)`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every English page has an Indonesian twin, and every Indonesian page an English original", () => {
  assert.deepEqual(pagesIn(ID), pagesIn(EN));
});

test("each page links to its other-language twin at the top", () => {
  const missing = [];
  const top = (rel) => read(rel).split(/\r?\n/).slice(0, 5);
  for (const f of pagesIn(EN)) {
    if (!top(`${EN}/${f}`).includes(`Bahasa Indonesia: [id/${f}](id/${f})`)) missing.push(`${EN}/${f}`);
    const twin = `${ID}/${f}`;
    if (fs.existsSync(path.join(root, twin)) && !top(twin).includes(`English: [../${f}](../${f})`)) missing.push(twin);
  }
  assert.deepEqual(missing, []);
});

const twins = () => pagesIn(ID).filter((f) => pagesIn(EN).includes(f));

test("Indonesian pages keep the English heading outline", () => {
  const outline = (rel) => headingsOf(read(rel)).map((h) => h.level).join(",");
  const differ = twins().filter((f) => outline(`${ID}/${f}`) !== outline(`${EN}/${f}`));
  assert.deepEqual(differ, [], "same number of headings, at the same levels, in the same order");
});

// A link's destination in a form both languages share: an external URL as it is; otherwise the root-relative file,
// with an Indonesian page counted as its English original, and an anchor as the position of its heading there.
function destination(rel, target) {
  if (isExternal(target)) return target;
  const [file, anchor] = target.split("#");
  const abs = resolveTarget(rel, file);
  let where = path.relative(root, abs).split(path.sep).join("/");
  if (where.startsWith(`${ID}/`)) where = `${EN}/${where.slice(ID.length + 1)}`;
  if (anchor === undefined) return where;
  const index = fs.existsSync(abs) ? headingsOf(fs.readFileSync(abs, "utf8")).findIndex((h) => h.anchor === anchor) : -1;
  return `${where}#heading-${index}`;
}

test("Indonesian pages link to the same places as the English ones", () => {
  const differ = [];
  // What is in a but not in b, counting repeats.
  const minus = (a, b) => {
    const rest = [...b];
    return a.filter((d) => {
      const i = rest.indexOf(d);
      if (i < 0) return true;
      rest.splice(i, 1);
      return false;
    });
  };
  for (const f of twins()) {
    const page = `${EN}/${f}`;
    // The language line links a page to its twin, which counts as the page itself; the test above checks it.
    const dests = (rel) => linkTargets(rel).map((t) => destination(rel, t)).filter((d) => d !== page);
    const en = dests(page);
    const id = dests(`${ID}/${f}`);
    const onlyEnglish = minus(en, id);
    const onlyIndonesian = minus(id, en);
    if (onlyEnglish.length || onlyIndonesian.length) differ.push({ page: f, onlyEnglish, onlyIndonesian });
  }
  assert.deepEqual(differ, []);
});

// Options written after an installer's name, up to the next installer name on the same line.
function documentedFlags() {
  const uses = [];
  const name = /\b(un)?install\.(sh|bat|ps1)\b/g;
  for (const rel of docFiles()) {
    read(rel).split(/\r?\n/).forEach((line, i) => {
      const hits = [...line.matchAll(name)];
      hits.forEach((h, k) => {
        const rest = line.slice(h.index + h[0].length, k + 1 < hits.length ? hits[k + 1].index : line.length);
        for (const f of rest.matchAll(/(?:^|[\s`(])(--[a-z][a-z-]*|-[A-Z][A-Za-z]+)\b/g)) {
          uses.push({ where: `${rel}:${i + 1}`, installer: h[0], flag: f[1] });
        }
      });
    });
  }
  return uses;
}

test("installer options in the docs are the installers' options", () => {
  const uses = documentedFlags();
  assert.ok(uses.length > 0, "the docs show no installer options at all");
  const wrong = uses.filter((u) => !ALLOWED[u.installer].includes(u.flag)).map((u) => `${u.where}: ${u.installer} ${u.flag}`);
  assert.deepEqual(wrong, []);
});

test("the install guide documents every installer option", () => {
  for (const rel of [`${EN}/install.md`, `${ID}/install.md`]) {
    const rows = read(rel).split(/\r?\n/).filter((l) => /^\|\s*`--/.test(l));
    const table = rows.map((l) => l.split("|").slice(1, 3).map((c) => c.trim().replace(/`/g, "").split(" ")[0]));
    assert.deepEqual(table.map((r) => r[0]), SH_FLAGS, `${rel}: the options table lists the Linux options in order`);
    assert.deepEqual(table.map((r) => r[1]), PS_FLAGS, `${rel}: the options table lists the Windows options in order`);
  }
});

// The installers' own --help output. On Windows, install.sh is read as text instead of run (a `bash` on PATH there may
// be WSL's); everywhere else it is run. install.ps1 is run only where Windows PowerShell exists.
function helpText(file) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return null;
  let r = null;
  if (file === "install.sh" && process.platform !== "win32") {
    r = spawnSync("bash", [abs, "--help"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  } else if (file === "install.ps1" && process.platform === "win32") {
    r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", abs, "-Help"], {
      cwd: root, encoding: "utf8", timeout: 60_000,
    });
  }
  if (!r) return { text: fs.readFileSync(abs, "utf8"), ran: false };
  assert.equal(r.error, undefined, `${file} --help could not run: ${r.error?.message}`);
  assert.equal(r.status, 0, `${file} --help exited ${r.status}: ${r.stderr}`);
  return { text: `${r.stdout}\n${r.stderr}`, ran: true };
}

for (const [file, flags] of [["install.sh", SH_FLAGS], ["install.ps1", PS_FLAGS]]) {
  const missing = !fs.existsSync(path.join(root, file));
  test(`${file} --help lists every documented option`, { skip: missing ? `${file} isn't there yet` : false }, () => {
    const help = helpText(file);
    const absent = flags.filter((f) => !new RegExp(`(^|[^\\w-])${f}(?![\\w-])`, "i").test(help.text));
    assert.deepEqual(absent, [], `${file} ${help.ran ? "--help output" : "source"} lacks these options`);
  });
}

test("every npm script the docs mention exists", () => {
  const scripts = appPackage().scripts ?? {};
  const unknown = [];
  for (const rel of docFiles()) {
    const text = read(rel);
    for (const m of text.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) if (!(m[1] in scripts)) unknown.push(`${rel}: npm run ${m[1]}`);
    if (/\bnpm test\b/.test(text) && !("test" in scripts)) unknown.push(`${rel}: npm test`);
  }
  assert.deepEqual(unknown, []);
});

test("local addresses use the default port or one the same page sets", () => {
  const wrong = [];
  for (const rel of docFiles()) {
    const text = read(rel);
    const set = new Set([DEFAULT_PORT]);
    for (const m of text.matchAll(/(?:--port|-Port)\s+(\d+)|\bPORT\s*=\s*["']?(\d+)/g)) set.add(m[1] ?? m[2]);
    // Another local server's OpenAI-compatible base URL (…:11434/v1) is not Watchbell's address.
    for (const m of text.matchAll(/\b(?:localhost|127\.0\.0\.1):(\d+)(?!\d|\/v1\b)/g)) if (!set.has(m[1])) wrong.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(wrong, []);
});

// The deny-list and the scanner live only in the private source tree (scripts/ is never exported).
const denylistFile = path.join(root, "..", "scripts", "scrub-denylist.txt");
const scanModule = path.join(root, "..", "scripts", "export", "scan.mjs");
const privateTree = fs.existsSync(denylistFile) && fs.existsSync(scanModule);

test("no owner identifier or secret in the docs", { skip: privateTree ? false : "the deny-list exists only in the private tree" }, async () => {
  const { loadAllow, loadDenylist, scanExport } = await import(pathToFileURL(scanModule).href);
  const mine = new Set([...docFiles(), "tests/docs.test.mjs"]);
  const findings = scanExport(root, { denylist: loadDenylist(denylistFile), allow: loadAllow(path.join(root, ".gitleaks-allow.json")) })
    .filter((f) => mine.has(f.path))
    .map((f) => `${f.path}:${f.line} ${f.rule}`);
  assert.deepEqual(findings, []);
});
