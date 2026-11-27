// Watchbell 1.8.6 (docs/superpowers/specs/2026-11-25-watchbell-1-8-6-alertmanager-design.md): Prometheus Alertmanager's
// webhook (version 4) → the alerts Watchbell writes as rule ExternalAlert. Pure: the route reads the body, this maps it.
// Only the envelope can fail the call; one bad alert inside it is skipped so the rest still arrive.
import { z } from "zod";
import type { Severity } from "@/db/schema";
import { clip, scrubLog } from "@/lib/logs/scrub";

export const AM_MAX_BYTES = 262_144;
export const AM_MAX_ALERTS = 100;
export const AM_PER_MINUTE = 120;
export const AM_STALE_MS = 86_400_000;

const MAX_LABELS = 20;
const MAX_LABEL_VALUE = 200;
const MAX_MESSAGE = 500;
const MAX_TITLE = 200;

export type ExternalAlertInput = {
  subject: string; status: "firing" | "resolved"; severity: Severity | null; title: string; message: string;
  labels: Record<string, string>; startedAt: Date;
};

const Envelope = z.object({ version: z.literal("4"), alerts: z.array(z.unknown()) });
const FINGERPRINT = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// Alertmanager writes 0001-01-01T00:00:00Z for "not set"; anything before 2000 is treated the same way.
const EARLIEST = Date.UTC(2000, 0, 1);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
// Final review I1: the log scrubber is slow on long text, so clip first (with room for a secret cut at the edge to be
// clipped away again) and scrub only that.
const clean = (text: string, max: number) => clip(scrubLog(text.slice(0, max * 2)), max);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function labelsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(raw))) {
    if (Object.keys(out).length >= MAX_LABELS) break;
    if (typeof v !== "string" || !LABEL_NAME.test(k)) continue;
    out[k] = clean(v, MAX_LABEL_VALUE);
  }
  return out;
}

function severityOf(labels: Record<string, string>): Severity | null {
  const s = labels.severity?.trim().toLowerCase();
  if (s === undefined || s === "") return null;
  return s === "critical" || s === "warning" ? s : "info";
}

function startOf(raw: unknown, now: Date): Date {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(t) && t >= EARLIEST && t <= now.getTime() ? new Date(t) : now;
}

function titleOf(labels: Record<string, string>): string {
  const name = labels.alertname || "Alertmanager alert";
  const where = labels.job || labels.instance;
  return clip(where ? `${name} · ${where}` : name, MAX_TITLE);
}

export function parseAlertmanager(body: unknown, now: Date): { ok: true; alerts: ExternalAlertInput[] } | { ok: false; error: string } {
  const env = Envelope.safeParse(body);
  if (!env.success) return { ok: false, error: "Expected an Alertmanager webhook body with version \"4\" and an alerts list." };
  if (env.data.alerts.length > AM_MAX_ALERTS) return { ok: false, error: `At most ${AM_MAX_ALERTS} alerts in one call.` };
  const alerts: ExternalAlertInput[] = [];
  for (const raw of env.data.alerts) {
    const a = record(raw);
    const fingerprint = str(a.fingerprint);
    const status = a.status === "firing" || a.status === "resolved" ? a.status : null;
    if (!fingerprint || !FINGERPRINT.test(fingerprint) || !status) continue;
    const labels = labelsOf(a.labels);
    const notes = record(a.annotations);
    const text = str(notes.summary) || str(notes.description) || "";
    alerts.push({
      subject: `am:${fingerprint}`, status, severity: severityOf(labels), title: titleOf(labels),
      message: clean(text.slice(0, MAX_MESSAGE * 4).replace(/\s+/g, " ").trim(), MAX_MESSAGE),
      labels, startedAt: startOf(a.startsAt, now),
    });
  }
  return { ok: true, alerts };
}
