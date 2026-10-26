// Watchbell 1.2.2 (D20): is the Node.js that Watchbell itself runs on missing a security release, or past end of life?
// Pure logic, no imports, shared by the CLI (bin/watchbell.mjs: `watchbell start` and `watchbell status`) and the
// console (src/lib/security/node-runtime.ts: Settings › Collector → Watchbell runtime). The data:
// - nodejs.org/dist/index.json: every release with `version`, `date`, `lts` and `security` (true on a security release);
// - endoflife.date's nodejs cycles (the same API v1 the Next.js end-of-life line reads).
// A version is vulnerable when its major line has a newer release marked security; "fixed in" is the newest of those.
// A line past end of life is reported as such whatever its patch level. "ok" needs a successful read of both sources,
// the latest nodejs.org read included; anything less is "unknown", never "ok".

export const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
export const NODE_EOL_URL = "https://endoflife.date/api/v1/products/nodejs/";
// Both sources are read at most once per 12 hours (the console's collector task and the CLI's own cache).
export const NODE_CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

/** @typedef {{ major: number; minor: number; patch: number; pre: string | null; text: string }} NodeVersion */
/** @typedef {{ security: string[]; latest: Record<string, string> }} NodeIndex Security releases (newest first) and each line's newest release. */
/** @typedef {{ name: string; isEol: boolean; eolFrom: string | null }} NodeCycle */
/** @typedef {"ok" | "vulnerable" | "eol" | "unknown"} NodeVerdictKind */
/**
 * @typedef {{ kind: NodeVerdictKind; state: "ok" | "warn" | "err" | "unknown"; version: string | null; fixedIn: string | null;
 *   eolFrom: string | null; text: string }} NodeVerdict
 */

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "v24.12.0", "24.12.0" or a pre-release such as "v26.0.0-rc.1"; null for anything else.
 * @param {unknown} v
 * @returns {NodeVersion | null}
 */
export function parseNodeVersion(v) {
  const m = typeof v === "string" ? VERSION.exec(v.trim()) : null;
  if (!m) return null;
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  return { major, minor, patch, pre: m[4] ?? null, text: `${major}.${minor}.${patch}${m[4] ? `-${m[4]}` : ""}` };
}

/**
 * Like a sort compare (<0, 0, >0). A release sorts after its own pre-releases; two pre-releases of one version compare
 * as text (Node's rc.1 … rc.9 never reach two digits).
 * @param {NodeVersion} a
 * @param {NodeVersion} b
 */
export function compareNodeVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * nodejs.org/dist/index.json, cut down to what the verdict needs. Null for anything that isn't a list of releases
 * whose every entry has a plain version and a true/false `security` (a captive portal page, a changed format): a list
 * the console can't fully read could hide a security release, so it counts as no answer.
 * @param {unknown} body
 * @returns {NodeIndex | null}
 */
export function parseNodeIndex(body) {
  if (!Array.isArray(body) || body.length === 0) return null;
  /** @type {NodeVersion[]} */
  const security = [];
  /** @type {Map<number, NodeVersion>} */
  const latest = new Map();
  for (const r of body) {
    if (!r || typeof r !== "object" || typeof r.security !== "boolean") return null;
    const v = parseNodeVersion(r.version);
    if (!v || v.pre !== null || !String(r.version).startsWith("v")) return null;
    if (r.security) security.push(v);
    const cur = latest.get(v.major);
    if (!cur || compareNodeVersions(v, cur) > 0) latest.set(v.major, v);
  }
  security.sort((a, b) => compareNodeVersions(b, a));
  return { security: security.map((v) => v.text), latest: Object.fromEntries([...latest].sort((a, b) => b[0] - a[0]).map(([m, v]) => [String(m), v.text])) };
}

/**
 * endoflife.date API v1 (`/products/nodejs/`): each cycle (a major) with its end-of-life flag and date. Null when the
 * answer isn't that shape.
 * @param {unknown} body
 * @returns {NodeCycle[] | null}
 */
export function parseNodeEol(body) {
  const releases = /** @type {{ result?: { releases?: unknown } } | null} */ (body && typeof body === "object" ? body : null)?.result?.releases;
  if (!Array.isArray(releases) || releases.length === 0) return null;
  /** @type {NodeCycle[]} */
  const cycles = [];
  for (const r of releases) {
    if (!r || typeof r !== "object" || typeof r.name !== "string" || typeof r.isEol !== "boolean") return null;
    if (r.eolFrom != null && (typeof r.eolFrom !== "string" || !DATE.test(r.eolFrom))) return null;
    cycles.push({ name: r.name, isEol: r.isEol, eolFrom: r.eolFrom ?? null });
  }
  return cycles;
}

/**
 * Data as it was stored (the console's settings row, the CLI's cache file): read back through the same checks, so a
 * hand-edited or old file can't produce an "ok".
 * @param {unknown} v
 * @returns {NodeIndex | null}
 */
export function storedNodeIndex(v) {
  const x = /** @type {{ security?: unknown; latest?: unknown } | null} */ (v && typeof v === "object" ? v : null);
  if (!x || !Array.isArray(x.security) || !x.latest || typeof x.latest !== "object") return null;
  const security = x.security.map(parseNodeVersion);
  const latest = Object.entries(x.latest).map(([k, s]) => [k, parseNodeVersion(s)]);
  if (security.some((s) => !s) || latest.some(([k, s]) => !s || String(s.major) !== k)) return null;
  return { security: security.map((s) => /** @type {NodeVersion} */ (s).text), latest: Object.fromEntries(latest.map(([k, s]) => [k, /** @type {NodeVersion} */ (s).text])) };
}

/** @param {unknown} v */
export function storedNodeCycles(v) {
  return parseNodeEol({ result: { releases: v } });
}

/**
 * The verdict for one running version.
 * - `index`: the last nodejs.org data read (also an older one), `indexFresh`: the latest read succeeded and is recent.
 *   An older read can still prove a version vulnerable (a security release never goes away), but only a fresh one
 *   proves "ok".
 * - `cycles`: endoflife.date's Node.js lines (null: never read). End-of-life dates are known long before, so the last
 *   successful read is used whatever its age; the date is compared with `now`.
 * @param {string} version process.version, such as "v24.12.0"
 * @param {{ index: NodeIndex | null; indexFresh: boolean; cycles: NodeCycle[] | null }} data
 * @param {number} now ms since the epoch
 * @returns {NodeVerdict}
 */
export function nodeVerdict(version, { index, indexFresh, cycles }, now) {
  const v = parseNodeVersion(version);
  if (!v) return { kind: "unknown", state: "unknown", version: null, fixedIn: null, eolFrom: null, text: `Node ${String(version)}: unknown (the version can't be read)` };
  const label = `Node ${v.text}`;
  /** @type {(why: string) => NodeVerdict} */
  const unknown = (why) => ({ kind: "unknown", state: "unknown", version: v.text, fixedIn: null, eolFrom: null, text: `${label}: unknown (${why})` });
  const cycle = cycles?.find((c) => c.name === String(v.major)) ?? null;
  const eolAt = cycle?.eolFrom ? Date.parse(`${cycle.eolFrom}T00:00:00Z`) : null;
  if (cycle && (cycle.isEol || (eolAt !== null && eolAt <= now))) {
    return { kind: "eol", state: "err", version: v.text, fixedIn: null, eolFrom: cycle.eolFrom, text: `${label}: end of life${cycle.eolFrom ? ` since ${cycle.eolFrom}` : ""}, no more security fixes` };
  }
  const fixedIn = index?.security.map(parseNodeVersion).find((s) => s && s.major === v.major && compareNodeVersions(s, v) > 0) ?? null;
  if (fixedIn) return { kind: "vulnerable", state: "warn", version: v.text, fixedIn: fixedIn.text, eolFrom: null, text: `${label}: security fix available (${fixedIn.text})` };
  if (!index) return unknown("nodejs.org hasn't been read yet");
  if (!indexFresh) return unknown("nodejs.org couldn't be read on the last try");
  if (!index.latest[String(v.major)]) return unknown(`nodejs.org lists no Node ${v.major} release`);
  if (!cycles) return unknown("endoflife.date hasn't been read yet");
  if (!cycle) return unknown(`endoflife.date has no Node ${v.major} line`);
  return { kind: "ok", state: "ok", version: v.text, fixedIn: null, eolFrom: null, text: `${label}: ok` };
}

/**
 * The CLI's one line for a vulnerable or end-of-life runtime; null otherwise (an unknown is not worth a line at start).
 * `service`: the Node.js path an installed service runs, when it isn't the one running the CLI (its fix is to update
 * that Node.js and install the service again, so it points at the new one).
 * @param {NodeVerdict} v
 * @param {{ service?: string | null }} [opts]
 * @returns {string | null}
 */
export function nodeWarningLine(v, { service = null } = {}) {
  const who = service ? `the Watchbell service's Node.js (${service}), version ${v.version},` : `Node.js ${v.version}`;
  const then = service ? "then run watchbell service install again" : "then restart Watchbell";
  if (v.kind === "vulnerable") return `warning: ${who} has a security fix available (${v.fixedIn}). Update Node.js, ${then}.`;
  if (v.kind === "eol") return `warning: ${who} is past end of life${v.eolFrom ? ` (since ${v.eolFrom})` : ""} and gets no security fixes. Move to a supported Node.js line, ${then}.`;
  return null;
}
