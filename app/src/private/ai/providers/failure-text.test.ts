import { describe, expect, it } from "vitest";
import { failureKind, isUnreachableStatus, MESSAGE_MAX, type NextStep, PROVIDERS_PAGE, providerFailureMessage, triesAnother, type ProviderFailure } from "./failure-text";

const f = (status: number, errorClass: string, detail?: string, provider = "my-router"): ProviderFailure => ({ provider, status, errorClass, ...(detail ? { detail } : {}) });
const tunnel = f(530, "server_error", "my-router failed (530). Try again later.");
const backup = (status: number, errorClass: string) => f(status, errorClass, undefined, "Workers AI");

describe("failureKind / triesAnother", () => {
  it("530, the other 52x, 502/503/504 and no answer at all (network, timeout) are unreachable", () => {
    for (const s of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530]) expect(isUnreachableStatus(s), String(s)).toBe(true);
    for (const s of [500, 501, 505, 519, 531, 429, 404]) expect(isUnreachableStatus(s), String(s)).toBe(false);
    expect(failureKind(f(530, "server_error"))).toBe("unreachable");
    expect(failureKind(f(0, "network"))).toBe("unreachable");
    expect(failureKind(f(0, "timeout"))).toBe("unreachable");
  });
  it("401/403 (and Google's key errors on a 400) are a refused key; 429 is a rate limit; 500 a server error", () => {
    expect(failureKind(f(401, "auth_rejected"))).toBe("auth");
    expect(failureKind(f(403, "project_denied"))).toBe("auth");
    expect(failureKind(f(400, "auth_rejected"))).toBe("auth");
    expect(failureKind(f(429, "rate_limited"))).toBe("rate_limited");
    expect(failureKind(f(500, "server_error"))).toBe("server");
    expect(failureKind(f(200, "bad_response"))).toBe("unreadable");
    expect(failureKind(f(400, "bad_request"))).toBe("other");
    expect(failureKind(f(404, "model_not_found"))).toBe("other");
  });
  it("another provider is tried when the first is down or busy, never on a refused key or a 4xx about the request", () => {
    for (const x of [tunnel, f(0, "network"), f(0, "timeout"), f(429, "rate_limited"), f(500, "server_error"), f(200, "bad_response")]) expect(triesAnother(x), JSON.stringify(x)).toBe(true);
    for (const x of [f(401, "auth_rejected"), f(403, "auth_rejected"), f(400, "bad_request"), f(404, "model_not_found"), f(422, "bad_request")]) expect(triesAnother(x), JSON.stringify(x)).toBe(false);
  });
});

describe("providerFailureMessage", () => {
  it("unreachable with no other provider: names the provider and the page to add one on", () => {
    expect(providerFailureMessage(tunnel, { kind: "none" })).toBe(
      `AI provider "my-router" is unreachable (its endpoint or tunnel is down). No other provider is enabled: add one on ${PROVIDERS_PAGE}, or check the endpoint.`,
    );
    expect(PROVIDERS_PAGE).toBe("Bring your own key (/ai/providers)");
    expect(providerFailureMessage(f(0, "network"), { kind: "none" })).toMatch(/^AI provider "my-router" is unreachable \(its endpoint or tunnel is down\)\. No other provider/);
  });
  it("the fallback failed too: names both providers", () => {
    const m = providerFailureMessage(tunnel, { kind: "tried", fallback: backup(503, "server_error") });
    expect(m).toBe('AI provider "my-router" is unreachable (its endpoint or tunnel is down). Tried "Workers AI" instead, and that failed too (unreachable).');
    expect(providerFailureMessage(tunnel, { kind: "tried", fallback: backup(401, "auth_rejected") })).toContain('Tried "Workers AI" instead, and that failed too (key refused, 401).');
    expect(providerFailureMessage(tunnel, { kind: "tried", fallback: backup(429, "rate_limited") })).toContain("(rate limited, 429)");
  });
  it("a refused key says so and where to replace it, with no next step (nothing else is tried)", () => {
    expect(providerFailureMessage(f(401, "auth_rejected", "my-router rejected the API key (401)."), { kind: "none" })).toBe(
      `AI provider "my-router" refused the key (401). Replace it on ${PROVIDERS_PAGE}.`,
    );
    // Google's own project errors keep their more useful hint
    expect(providerFailureMessage(f(403, "project_denied", "Google denied this project's Gemini API access. Use a key from another Google project or account."), { kind: "none" }))
      .toBe("AI provider \"my-router\" refused the key (403). Google denied this project's Gemini API access. Use a key from another Google project or account.");
  });
  it("429 is a rate limit; with no other provider the advice is to wait", () => {
    expect(providerFailureMessage(f(429, "rate_limited"), { kind: "none" })).toBe(
      `AI provider "my-router" is rate limited (429): its quota is used up. No other provider is enabled: add one on ${PROVIDERS_PAGE}, or try again later.`,
    );
  });
  it("other 4xx keep the provider's curated message, clipped to one line", () => {
    expect(providerFailureMessage(f(400, "bad_request", "my-router refused the request (400). Check the request body."), { kind: "none" })).toBe("my-router refused the request (400). Check the request body.");
    const long = providerFailureMessage(f(404, "model_not_found", `x${"y".repeat(400)}\nz`), { kind: "none" });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
    expect(providerFailureMessage(f(418, "http_418"), { kind: "none" })).toBe('AI provider "my-router" answered 418.');
  });
  it("a pinned model and a spent time budget say why nothing else was tried", () => {
    expect(providerFailureMessage(tunnel, { kind: "pinned" })).toBe('AI provider "my-router" is unreachable (its endpoint or tunnel is down). This model was picked by name, so no other provider was tried.');
    expect(providerFailureMessage(tunnel, { kind: "out-of-time" })).toMatch(/There was no time left to try another provider\.$/);
  });
  it("Indonesian twin for the office reports", () => {
    expect(providerFailureMessage(tunnel, { kind: "none" }, "id")).toBe(
      `Penyedia AI "my-router" tak bisa dihubungi (endpoint atau tunnel-nya mati). Tak ada penyedia lain yang aktif: tambah di ${PROVIDERS_PAGE}, atau cek endpoint-nya.`,
    );
    expect(providerFailureMessage(tunnel, { kind: "tried", fallback: backup(530, "server_error") }, "id")).toBe(
      'Penyedia AI "my-router" tak bisa dihubungi (endpoint atau tunnel-nya mati). Sudah dicoba "Workers AI" sebagai gantinya, tapi juga gagal (tidak bisa dihubungi).',
    );
    expect(providerFailureMessage(f(401, "auth_rejected"), { kind: "none" }, "id")).toBe(`Penyedia AI "my-router" menolak kuncinya (401). Ganti kuncinya di ${PROVIDERS_PAGE}.`);
  });
  it("fits 200 characters in EN and ID for every kind and step, even with two 60-character names; both names stay in", () => {
    const A = "a".repeat(60);
    const B = "b".repeat(60);
    const named = (p: ProviderFailure, provider: string): ProviderFailure => ({ ...p, provider });
    const firsts = [
      tunnel, f(0, "network"), f(0, "timeout"), f(429, "rate_limited"), f(500, "server_error"), f(200, "bad_response"),
      f(401, "auth_rejected"), f(403, "project_denied", "Google denied this project's Gemini API access. Use a key from another Google project or account."),
      f(400, "bad_request", `${A} refused the request (400). Check the request body.`), f(404, "model_not_found", `${A} doesn't know this model (404).`), f(418, "http_418"),
    ];
    const fallbacks = [backup(530, "server_error"), backup(0, "timeout"), backup(401, "auth_rejected"), backup(429, "rate_limited"), backup(500, "server_error"), backup(200, "bad_response"), backup(418, "http_418")];
    const steps = [{ kind: "none" }, { kind: "pinned" }, { kind: "out-of-time" }, ...fallbacks.map((x) => ({ kind: "tried", fallback: named(x, B) }))] as const;
    for (const lang of ["en", "id"] as const) {
      for (const first of firsts) {
        for (const step of steps) {
          const m = providerFailureMessage(named(first, A), step as NextStep, lang);
          const label = `${lang} ${first.status}/${first.errorClass} ${step.kind}: ${m}`;
          expect(m.length, label).toBeLessThanOrEqual(MESSAGE_MAX);
          expect(m.endsWith("…"), label).toBe(false); // only names are clipped, never the sentence
          if (first.errorClass !== "bad_request" && first.errorClass !== "model_not_found") expect(m, label).toMatch(/"a{8,}…?"/);
          if (step.kind === "tried" && triesAnother(first)) {
            expect(m, label).toMatch(/"b{8,}…?"/); // the fallback is named too, not cut off
            expect(m, label).toMatch(/\)\.$/); // and the "failed too (reason)." part is whole
          }
        }
      }
    }
    // short names are never clipped
    expect(providerFailureMessage(tunnel, { kind: "tried", fallback: backup(503, "server_error") }, "id")).toContain('"my-router"');
  });
  it("emoji in connection names are never split into a lone surrogate (EN and ID, tried and none)", () => {
    const emojiName = (glyph: string, chars: number) => glyph.repeat(chars / 2); // each emoji is 2 UTF-16 units
    for (const lang of ["en", "id"] as const) {
      for (let a = 30; a <= 60; a++) {
        for (const b of [30, 31, 45, 59, 60]) {
          const first = { ...tunnel, provider: `${emojiName("😀", a - (a % 2))}${a % 2 ? "x" : ""}` };
          const fallback = { ...backup(530, "server_error"), provider: `${b % 2 ? "y" : ""}${emojiName("🏠", b - (b % 2))}` };
          for (const step of [{ kind: "none" }, { kind: "tried", fallback }] as const) {
            const m = providerFailureMessage(first, step as NextStep, lang);
            const label = `${lang} ${a}/${b} ${step.kind}: ${m}`;
            expect(m.isWellFormed(), label).toBe(true);
            expect(m.length, label).toBeLessThanOrEqual(MESSAGE_MAX);
          }
        }
      }
    }
  });
  it("never more than the name and status: no detail leaks into the unreachable text, long names are clipped", () => {
    const m = providerFailureMessage({ ...tunnel, detail: "Traceback sk-live-123 https://user:pw@tunnel.example" }, { kind: "none" });
    expect(m).not.toContain("sk-live");
    expect(m).not.toContain("://");
    const named = providerFailureMessage({ ...tunnel, provider: "n".repeat(200) }, { kind: "none" });
    expect(named).toMatch(/^AI provider "n+…" is unreachable/);
    expect(named.length).toBeLessThanOrEqual(MESSAGE_MAX);
  });
});
