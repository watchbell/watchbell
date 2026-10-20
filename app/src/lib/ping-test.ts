// The Ping URL dialog's "Send test ping" / "Test fail" result line. `status` is the HTTP status of the same-origin
// request, or null when it never got an answer.
export type PingTestResult = { ok: boolean; text: string };

export function pingTestResult(status: number | null): PingTestResult {
  if (status === null) return { ok: false, text: "Couldn't reach the console" };
  if (status >= 200 && status < 300) return { ok: true, text: `OK · ${status}` };
  if (status === 404) return { ok: false, text: "Not found · 404" };
  if (status === 429) return { ok: false, text: "Too many pings · 429" };
  return { ok: false, text: `Failed · ${status}` };
}

// The path the dialog calls: the real ping URL's own path, so it stays same-origin whatever SITE_URL says.
export function pingTestPath(url: string, kind: "ok" | "fail"): string | null {
  const m = /\/api\/ping\/(hb_[0-9a-f]{32})\/?$/.exec(url);
  return m ? `/api/ping/${m[1]}${kind === "fail" ? "/fail" : ""}` : null;
}
