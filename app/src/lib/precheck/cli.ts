import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { OSV_BATCH_URL, OSV_VULN_URL } from "@/lib/deps/osv";
import { commentBody, type PrecheckResult, verdictLine } from "./report";
import { addedSourceLines, postComment, type RunIo, runPrecheck, scannedReport } from "./run";

// Watchbell 1.4 pre-deploy check, the entry GitHub Actions runs (bundled into public-edition/precheck/precheck.mjs by
// scripts/precheck-bundle.mjs; the reusable workflow is public-edition/.github/workflows/precheck.yml). Inputs come
// from env variables only and are checked here again. Warning only: it always exits 0, whatever happens.

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const DIR = /^(?:[A-Za-z0-9._-]+\/){0,4}[A-Za-z0-9._-]+$/;
const MAX_BUFFER = 64 * 1024 * 1024;

const git = async (args: string[]) => (await run("git", args, { maxBuffer: MAX_BUFFER, encoding: "utf8" })).stdout;

// OSV.dev, tried twice: one dropped connection shouldn't leave a pull request unchecked.
async function json(url: string, init: RequestInit = {}, tries = 2): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", "user-agent": "watchbell-precheck", ...init.headers }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (res.status >= 500 && tries > 1) return json(url, init, tries - 1);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (tries > 1 && !(e instanceof Error && e.message.startsWith("HTTP "))) return json(url, init, tries - 1);
    throw e;
  }
}

// Workflow command data: %, CR and LF escaped; property values also : and ,.
const data = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const prop = (v: string) => data(v).replace(/:/g, "%3A").replace(/,/g, "%2C");
const warn = (msg: string, at?: { file: string; line: number }) =>
  console.log(`::warning${at ? ` file=${prop(at.file)},line=${at.line}` : ""}::${data(msg)}`);

function annotate(r: PrecheckResult): void {
  if (r.packages.ok) {
    for (const v of r.packages.items) if (v.severity === "critical" || v.severity === "high") warn(`${v.package}@${v.installedVersion} has ${v.vulnId} (${v.severity})${v.fixedVersion ? `, fixed in ${v.fixedVersion}` : ""}.`);
  } else warn(`Packages not checked: ${r.packages.reason}`);
  if (r.secrets.ok) for (const s of r.secrets.items) warn(`Possible secret (rule ${s.rule}). Remove it and rotate it.`, { file: s.file, line: s.line });
  else warn(`Secrets not checked: ${r.secrets.reason}`);
  if (!r.env.ok) warn(`Env names not checked: ${r.env.reason}`);
}

async function main(): Promise<void> {
  const env = process.env;
  const head = env.HEAD_SHA ?? "";
  const baseTip = env.BASE_SHA ?? "";
  const dir = (env.WORK_DIR ?? ".").replace(/^\.\/|\/$/g, "") || ".";
  if (!SHA.test(head) || !SHA.test(baseTip) || (dir !== "." && (!DIR.test(dir) || dir.split("/").some((p) => p === "." || p === "..")))) {
    warn("Watchbell pre-deploy check: the commit or working-directory input isn't valid, so nothing was checked.");
    return;
  }
  // The point the branch left the base: what the base gained since isn't this pull request's doing.
  const base = (await git(["merge-base", baseTip, head]).catch(() => baseTip)).trim() || baseTip;

  const io: RunIo = {
    show: (ref, path) => git(["show", `${ref}:${path}`]).catch(() => null),
    addedLines: async (b, h, d) => addedSourceLines(await git(["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", b, h, "--", d])),
    osvBatch: (body) => json(OSV_BATCH_URL, { method: "POST", body: JSON.stringify(body) }),
    osvVuln: (id) => json(OSV_VULN_URL + encodeURIComponent(id)),
    gitleaksReport: () => scannedReport(env.GITLEAKS_OUTCOME, async () => (env.GITLEAKS_REPORT ? readFile(env.GITLEAKS_REPORT, "utf8").catch(() => null) : null)),
  };
  const result = await runPrecheck({ base, head, dir }, io);
  const body = commentBody(result, new Date());
  console.log(verdictLine(result).replace(/\*\*/g, ""));
  annotate(result);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${body}\n`).catch(() => undefined);
  if (env.DRY_RUN) {
    console.log(body);
    return;
  }
  const pr = Number(env.PR_NUMBER);
  if (!env.GITHUB_TOKEN || !env.REPOSITORY || !Number.isInteger(pr)) {
    warn("No pull request to comment on: the result is in the job summary.");
    return;
  }
  const posted = await postComment({ repo: env.REPOSITORY, pr, token: env.GITHUB_TOKEN, body }, fetch);
  if (!posted.ok) warn(`The pull request comment wasn't written (${posted.error}) — a pull request from a fork can't be commented on. The result is in the job summary.`);
}

main().catch((e) => warn(`Watchbell pre-deploy check stopped: ${e instanceof Error ? e.message : String(e)}`)).finally(() => { process.exitCode = 0; });
