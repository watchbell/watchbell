import { describe, expect, it } from "vitest";
import { AM_MAX_ALERTS, parseAlertmanager } from "./alertmanager";

const now = new Date("2026-11-25T10:00:00Z");
const alert = (o: Record<string, unknown> = {}) => ({
  status: "firing",
  labels: { alertname: "HighErrorRate", job: "pos-api", instance: "10.0.3.14:9100", severity: "critical" },
  annotations: { summary: "5xx responses above 5% for 10 minutes." },
  startsAt: "2026-11-25T09:52:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus:9090/graph",
  fingerprint: "a3f9c21e07b4",
  ...o,
});
const body = (alerts: unknown[], o: Record<string, unknown> = {}) => ({ version: "4", status: "firing", receiver: "watchbell", groupKey: "{}:{}", alerts, ...o });
const one = (o: Record<string, unknown> = {}) => {
  const r = parseAlertmanager(body([alert(o)]), now);
  if (!r.ok) throw new Error(r.error);
  return r.alerts;
};

describe("parseAlertmanager (webhook version 4)", () => {
  it("maps a firing alert to subject, title, severity, message, labels and start", () => {
    expect(one()).toEqual([{
      subject: "am:a3f9c21e07b4", status: "firing", severity: "critical", title: "HighErrorRate · pos-api",
      message: "5xx responses above 5% for 10 minutes.",
      labels: { alertname: "HighErrorRate", job: "pos-api", instance: "10.0.3.14:9100", severity: "critical" },
      startedAt: new Date("2026-11-25T09:52:00Z"),
    }]);
  });

  it("refuses another webhook version", () => {
    expect(parseAlertmanager(body([alert()], { version: "3" }), now)).toMatchObject({ ok: false });
    expect(parseAlertmanager({ alerts: [] }, now)).toMatchObject({ ok: false });
    expect(parseAlertmanager("nope", now)).toMatchObject({ ok: false });
    expect(parseAlertmanager(body("x" as unknown as unknown[]), now)).toMatchObject({ ok: false });
  });

  it("refuses more than 100 alerts in one call", () => {
    const r = parseAlertmanager(body(Array.from({ length: AM_MAX_ALERTS + 1 }, (_, i) => alert({ fingerprint: `f${i}` }))), now);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/100/) });
    expect(parseAlertmanager(body(Array.from({ length: AM_MAX_ALERTS }, (_, i) => alert({ fingerprint: `f${i}` }))), now)).toMatchObject({ ok: true });
  });

  it("skips an alert without a usable fingerprint or status, and keeps the others", () => {
    const r = parseAlertmanager(body([alert({ fingerprint: undefined }), alert({ fingerprint: "../x" }), alert({ status: "pending" }), alert({ fingerprint: "b1" }), 42, null]), now);
    expect(r.ok && r.alerts.map((a) => a.subject)).toEqual(["am:b1"]);
  });

  it("takes the severity label: critical and warning as they are, anything else info, none → the rule's default", () => {
    const sev = (s: unknown) => one({ labels: { alertname: "A", ...(s === undefined ? {} : { severity: s }) } })[0].severity;
    expect(sev("critical")).toBe("critical");
    expect(sev("Warning")).toBe("warning");
    expect(sev("page")).toBe("info");
    expect(sev(undefined)).toBeNull();
  });

  it("names the alert by alertname and job, else instance, else alertname alone", () => {
    expect(one({ labels: { alertname: "DiskFull", instance: "db-1:9100" } })[0].title).toBe("DiskFull · db-1:9100");
    expect(one({ labels: { alertname: "DiskFull" } })[0].title).toBe("DiskFull");
    expect(one({ labels: {} })[0].title).toBe("Alertmanager alert");
  });

  it("keeps up to 20 string labels, values clipped to 200 characters", () => {
    const labels: Record<string, unknown> = { alertname: "Many", count: 3, nested: { a: 1 }, long: "x".repeat(10_000) };
    for (let i = 0; i < 25; i++) labels[`l${i}`] = `v${i}`;
    const got = one({ labels })[0].labels;
    expect(Object.keys(got)).toHaveLength(20);
    expect(got).not.toHaveProperty("count");
    expect(got).not.toHaveProperty("nested");
    expect(got.long).toHaveLength(200);
  });

  it("starts at now when startsAt is in the future, Alertmanager's zero time or not a date", () => {
    expect(one({ startsAt: "2099-01-01T00:00:00Z" })[0].startedAt).toEqual(now);
    expect(one({ startsAt: "0001-01-01T00:00:00Z" })[0].startedAt).toEqual(now);
    expect(one({ startsAt: "yesterday" })[0].startedAt).toEqual(now);
  });

  it("uses the description when there is no summary, clips to 500 and hides secrets and emails", () => {
    expect(one({ annotations: { description: "Disk is 95% full." } })[0].message).toBe("Disk is 95% full.");
    expect(one({ annotations: {} })[0].message).toBe("");
    expect(one({ annotations: { summary: "y".repeat(900) } })[0].message).toHaveLength(500);
    const m = one({ annotations: { summary: "Call ops@kopisenja.example, token=abc123secret, runbook https://wiki.example/rb/disk" } })[0].message;
    expect(m).not.toContain("ops@kopisenja.example");
    expect(m).not.toContain("abc123secret");
    expect(m).toContain("https://wiki.example/rb/disk");
  });

  it("passes resolved alerts through, in the order they came", () => {
    const r = parseAlertmanager(body([alert(), alert({ status: "resolved" })]), now);
    expect(r.ok && r.alerts.map((a) => a.status)).toEqual(["firing", "resolved"]);
  });

  // Final review I1: the log scrubber is slow on long text, so a 200 KB summary or label must be clipped before it is
  // scrubbed; otherwise one call could burn its whole 30 s of CPU.
  it("handles a 200 KB summary and label value quickly", () => {
    const huge = "a-".repeat(100_000);
    const t0 = Date.now();
    const [a] = one({ annotations: { summary: huge }, labels: { alertname: "Big", note: huge } });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(a.message).toHaveLength(500);
    expect(a.labels.note).toHaveLength(200);
  });
});
