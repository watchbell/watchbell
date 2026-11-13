import { type Dep, LOCKFILES, parseLockfile } from "@/lib/deps/lockfile";
import { type Advisory, batchBodies, findings, parseAdvisory, parseBatch } from "@/lib/deps/osv";
import { addedDeps, nextVersions } from "./diff";
import { addedEnvNames } from "./env";
import { MARKER, type Part, parseGitleaks, type PrecheckResult } from "./report";

// Watchbell 1.4 pre-deploy check: one run over a pull request, with git, OSV.dev and gitleaks' report injected (cli.ts
// wires the real ones inside GitHub Actions). Each part fails on its own: a part that couldn't run says why and the
// others still report. Nothing here throws.

export type RunIo = {
  // A file's text at a commit; null when it isn't there.
  show(ref: string, path: string): Promise<string | null>;
  addedLines(base: string, head: string, dir: string): Promise<string[]>;
  osvBatch(body: unknown): Promise<unknown>;
  osvVuln(id: string): Promise<unknown>;
  gitleaksReport(): Promise<string | null>;
};

export const ADVISORIES_MAX = 300;
const PARALLEL = 8;
// "fetch failed" alone says nothing: Node keeps the reason (ENOTFOUND, a timeout…) in `cause`.
const why = (e: unknown) => {
  const cause = e instanceof Error && e.cause instanceof Error ? (e.cause as Error & { code?: string }).code ?? e.cause.message : null;
  return `${e instanceof Error ? e.message : String(e)}${cause ? `: ${cause}` : ""}`.slice(0, 200);
};

async function packages(o: { base: string; head: string; dir: string }, io: RunIo): Promise<{ part: Part<ReturnType<typeof findings>>; next: PrecheckResult["next"]; baseNote?: string | null }> {
  const prefix = o.dir === "." ? "" : `${o.dir}/`;
  let found: { path: string; kind: (typeof LOCKFILES)[number]["kind"]; text: string } | null = null;
  for (const l of LOCKFILES) {
    const text = await io.show(o.head, prefix + l.path);
    if (text !== null) { found = { ...l, path: prefix + l.path, text }; break; }
  }
  const none = { from: null, to: null };
  if (!found) return { part: { ok: false, reason: `No lockfile in ${o.dir === "." ? "the repository root" : o.dir}.` }, next: none };
  const head = parseLockfile(found.kind, found.text);
  if (!head) return { part: { ok: false, reason: `${found.path} couldn't be read.` }, next: none };
  const baseText = await io.show(o.base, found.path);
  const base: Dep[] | null = baseText === null ? null : parseLockfile(found.kind, baseText);
  // Review (1.4): compared against nothing, every package looks new; the comment says why.
  const baseNote = base ? null : baseText === null
    ? `The base branch has no ${found.path}, so every package counts as new.`
    : `The base branch's ${found.path} couldn't be read, so every package counts as new.`;
  const next = nextVersions(base, head);
  const added = addedDeps(base, head);
  if (!added.length) return { part: { ok: true, items: [] }, next, baseNote };
  try {
    const ids: string[][] = [];
    for (const body of batchBodies(added)) {
      const parsed = parseBatch(await io.osvBatch(body), body.queries.length);
      if (!parsed) throw new Error("an answer it couldn't read");
      ids.push(...parsed);
    }
    const unique = [...new Set(ids.flat())];
    if (unique.length > ADVISORIES_MAX) throw new Error(`${unique.length} advisories, more than ${ADVISORIES_MAX}`);
    const map = new Map<string, Advisory>();
    for (let i = 0; i < unique.length; i += PARALLEL) {
      await Promise.all(unique.slice(i, i + PARALLEL).map(async (id) => {
        const a = parseAdvisory(await io.osvVuln(id));
        if (a) map.set(id, a);
      }));
    }
    return { part: { ok: true, items: findings(added, ids, map) }, next, baseNote };
  } catch (e) {
    return { part: { ok: false, reason: `OSV.dev couldn't be asked (${why(e)}).` }, next, baseNote };
  }
}

export async function runPrecheck(o: { base: string; head: string; dir: string }, io: RunIo): Promise<PrecheckResult> {
  const pk = await packages(o, io).catch((e) => ({ part: { ok: false as const, reason: `Packages couldn't be read (${why(e)}).` }, next: { from: null, to: null } }));
  const report = await io.gitleaksReport().catch(() => null);
  const leaks = parseGitleaks(report);
  let env: PrecheckResult["env"];
  try {
    const example = `${o.dir === "." ? "" : `${o.dir}/`}.env.example`;
    env = { ok: true, items: addedEnvNames(await io.show(o.base, example), await io.show(o.head, example), await io.addedLines(o.base, o.head, o.dir)) };
  } catch (e) {
    env = { ok: false, reason: `The diff couldn't be read (${why(e)}).` };
  }
  return {
    sha: o.head, dir: o.dir, packages: pk.part, next: pk.next, env, baseNote: "baseNote" in pk ? pk.baseNote ?? null : null,
    secrets: leaks ? { ok: true, items: leaks } : { ok: false, reason: "gitleaks didn't run." },
  };
}

// gitleaks writes "[]" before it exits 1 on an error, so its report only counts after a scan step that succeeded
// (review, 1.4); anything else is "gitleaks didn't run", never "no secrets".
export async function scannedReport(outcome: string | undefined, read: () => Promise<string | null>): Promise<string | null> {
  return outcome === "success" ? read() : null;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/;

// `git diff --unified=0` → the added lines of source files (tests left out), for the env-name reads.
export function addedSourceLines(diff: string): string[] {
  const out: string[] = [];
  let keep = false;
  let header = false; // a "+++ " line is the file's name only right after "--- " (else it's an added "++…" line)
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      keep = false;
      header = false;
    } else if (line.startsWith("--- ") && !keep) {
      header = true;
    } else if (header && line.startsWith("+++ ")) {
      // git quotes unusual names: +++ "b/sp ace.ts"
      const path = line.slice(4).replace(/^"(.*)"$/, "$1").replace(/^b\//, "");
      keep = SOURCE.test(path) && !TEST.test(path);
      header = false;
    } else if (keep && line.startsWith("+")) {
      out.push(line.slice(1));
    }
  }
  return out;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BOT = "github-actions[bot]";

// One comment per pull request: the newest marker comment the Actions bot wrote is edited, else one is added. A fork's
// pull request gets a read-only token, so the write fails; the job summary still has the result.
export async function postComment(o: { repo: string; pr: number; token: string; body: string }, f: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!REPO.test(o.repo) || o.repo.includes("..") || !Number.isInteger(o.pr) || o.pr < 1) return { ok: false, error: "That isn't a repository or pull request." };
  const api = `https://api.github.com/repos/${o.repo}`;
  const headers = { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "watchbell-precheck" };
  try {
    let mine: number | null = null;
    for (let page = 1; page <= 3; page++) {
      const res = await f(`${api}/issues/${o.pr}/comments?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { ok: false, error: `GitHub answered HTTP ${res.status} to the comment list.` };
      const list = (await res.json()) as unknown;
      if (!Array.isArray(list)) return { ok: false, error: "GitHub's comment list couldn't be read." };
      for (const c of list as { id?: unknown; body?: unknown; user?: { login?: unknown } }[]) {
        if (typeof c.id === "number" && typeof c.body === "string" && c.user?.login === BOT && c.body.trimStart().startsWith(MARKER)) mine = c.id;
      }
      if (list.length < 100) break;
    }
    const res = mine === null
      ? await f(`${api}/issues/${o.pr}/comments`, { method: "POST", headers, body: JSON.stringify({ body: o.body }), signal: AbortSignal.timeout(15_000) })
      : await f(`${api}/issues/comments/${mine}`, { method: "PATCH", headers, body: JSON.stringify({ body: o.body }), signal: AbortSignal.timeout(15_000) });
    return res.ok ? { ok: true } : { ok: false, error: `GitHub answered HTTP ${res.status} to the comment.` };
  } catch (e) {
    return { ok: false, error: `GitHub couldn't be reached (${why(e)}).` };
  }
}
