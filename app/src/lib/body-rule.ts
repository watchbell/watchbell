// U2: "200 OK but broken". A monitor may require a plain substring (no regex, so no ReDoS) or a JSON value at a simple
// path (a.b[0].c; our own walker, no JSONPath dependency). Only the first 256 KB of the body is read, and nothing is
// stored but the short error.
export type BodyRule = { kind: "contains"; text: string } | { kind: "json"; path: string; equals: string };
export const BODY_MAX_BYTES = 256 * 1024;

const PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d{1,6}\])*$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export function parsePath(path: string): (string | number)[] | null {
  if (!PATH.test(path)) return null;
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return out.some((s) => typeof s === "string" && FORBIDDEN.has(s)) ? null : out;
}

function valueAt(v: unknown, segs: (string | number)[]): { found: boolean; value?: unknown } {
  let cur: unknown = v;
  for (const s of segs) {
    if (typeof s === "number") {
      if (!Array.isArray(cur) || s >= cur.length) return { found: false };
      cur = cur[s];
    } else {
      if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, s)) return { found: false };
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return { found: true, value: cur };
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

export function bodyProblem(rule: BodyRule, body: string, truncated: boolean): string | null {
  if (rule.kind === "contains") return body.includes(rule.text) ? null : truncated ? "Keyword not found in the first 256 KB" : "Keyword not found";
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return truncated ? "Response is larger than 256 KB" : "Response isn't JSON";
  }
  const segs = parsePath(rule.path);
  if (!segs) return `JSON ${rule.path} is missing`;
  const r = valueAt(json, segs);
  if (!r.found) return `JSON ${rule.path} is missing`;
  const got = typeof r.value === "string" ? r.value : JSON.stringify(r.value);
  return got === rule.equals ? null : `JSON ${rule.path} is ${short(JSON.stringify(r.value) ?? "undefined")}, expected "${short(rule.equals)}"`;
}

export function ruleFrom(m: { bodyContains: string | null; jsonPath: string | null; jsonEquals: string | null }): BodyRule | null {
  if (m.bodyContains) return { kind: "contains", text: m.bodyContains };
  if (m.jsonPath && m.jsonEquals !== null) return { kind: "json", path: m.jsonPath, equals: m.jsonEquals };
  return null;
}
