// S5: runtime-log text leaves Vercel only after this. It masks what commonly leaks into logs: bearer tokens, JWTs,
// key=value secrets (also in JSON), credentials in URLs and connection strings, email addresses, and long hex or
// base64 runs that look like keys. It is a safety net, not a guarantee; viewers never see logs at all.
const RULES: [RegExp, string][] = [
  // B2: a heartbeat ping token in a request path or message (/api/ping/hb_<32 hex>[/fail|/start]). First, so no later
  // rule half-masks it. Next decodes route params, so a percent-encoded token (hb%5F…, also behind an encoded slash)
  // is a valid ping whose logged path stays encoded (5b final review M4).
  [/(?:\b|(?<=%2F))hb(?:_|%5F)[0-9a-f]{32}\b/gi, "hb_[hidden]"],
  // Whatever else follows the ping prefix (encoded letters such as %68%62_…, an encoded slash) is hidden whole.
  [/(\/api(?:\/|%2F)ping(?:\/|%2F))(?!hb_\[hidden\])[^/?#\s]+/gi, "$1[hidden]"],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/\S+/gi, "$1://[hidden]"],
  [/\b(https?):\/\/[^\s/@:]+:[^\s/@]+@/gi, "$1://[hidden]@"],
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [hidden]"],
  // The value may not start with "Bearer"/"Basic": that one was masked just above ("Authorization: Bearer [hidden]").
  [/\b((?:access_|refresh_|id_)?token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|cookie|session|private_key)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b)([^\s"'&,;}]+)/gi, "$1$2[hidden]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[jwt]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[redacted]"],
  // Long key-like runs: letters and digits mixed, no slashes (so long URL paths survive).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
];

export function scrubLog(text: string): string {
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function pathOnly(path: string | null): string | null {
  if (path === null) return null;
  return clip(path.split(/[?#]/)[0] || "/", 512);
}
