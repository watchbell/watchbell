import { z } from "zod";
import type { ServiceAccount } from "./google";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Firebase on Spark, read-only (checked 12 Oct 2026):
// - projects: Firebase Management API projects.list (roles/firebase.viewer)
// - health: one Firestore REST document get (roles/datastore.viewer), 1 read of the 50k a day
// - Auth users: Identity Toolkit accounts:query with returnUserInfo=false (permission firebaseauth.users.get)
// - reads/writes/deletes today: Cloud Monitoring timeSeries.list (roles/monitoring.viewer). Needs test on Spark.
// Stored data size has no API; the page links to the console's usage page.

export async function listFirebaseProjects(token: string, opts: FetchOpts = {}): Promise<Result<{ projectId: string; displayName: string }[]>> {
  const r = await callJson("Firebase", "https://firebase.googleapis.com/v1beta1/projects?pageSize=100", { token }, opts);
  if (!r.ok) return r;
  const p = z.object({ results: z.array(z.object({ projectId: z.string(), displayName: z.string().optional(), state: z.string().optional() })).optional() }).safeParse(r.data);
  if (!p.success) return formatFailure("Firebase", "the project list");
  return { ok: true, data: (p.data.results ?? []).filter((x) => x.state !== "DELETED").map((x) => ({ projectId: x.projectId, displayName: x.displayName ?? x.projectId })) };
}

export async function discoverFirebase(sa: ServiceAccount, token: string, opts: FetchOpts = {}): Promise<Result<{ projectId: string; displayName: string }[]>> {
  return withOwnProject(sa, await listFirebaseProjects(token, opts));
}

export function withOwnProject(sa: ServiceAccount, r: Result<{ projectId: string; displayName: string }[]>): Result<{ projectId: string; displayName: string }[]> {
  // Without firebase.viewer the list is refused; the service account's own project is still known from its JSON.
  if (!r.ok && r.kind !== "scope") return r;
  const list = r.ok ? r.data : [];
  return { ok: true, data: list.some((p) => p.projectId === sa.project_id) ? list : [{ projectId: sa.project_id, displayName: sa.project_id }, ...list] };
}

export type Ping = { reachable: boolean; noDatabase: boolean; latencyMs: number };
const pid = (v: string) => encodeURIComponent(v);

export async function firestorePing(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<Ping>> {
  const started = performance.now();
  const r = await callJson("Firestore", `https://firestore.googleapis.com/v1/projects/${pid(projectId)}/databases/(default)/documents/ops/ping`, { token }, opts);
  const latencyMs = Math.round(performance.now() - started);
  if (r.ok) return { ok: true, data: { reachable: true, noDatabase: false, latencyMs } };
  if (r.kind === "missing") {
    const noDatabase = /database .*does not exist/i.test(r.message ?? "");
    return { ok: true, data: { reachable: !noDatabase, noDatabase, latencyMs } };
  }
  return r;
}

export async function authUserCount(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<number>> {
  const r = await callJson("Firebase Auth", `https://identitytoolkit.googleapis.com/v1/projects/${pid(projectId)}/accounts:query`, { method: "POST", token, body: { returnUserInfo: false } }, opts);
  if (!r.ok) return r;
  const p = z.object({ recordsCount: z.union([z.string(), z.number()]).optional() }).safeParse(r.data);
  const n = p.success ? Number(p.data.recordsCount ?? 0) : NaN;
  return Number.isFinite(n) ? { ok: true, data: n } : formatFailure("Firebase Auth", "the user count");
}

const seriesSchema = z.object({ timeSeries: z.array(z.object({ points: z.array(z.object({ value: z.object({ int64Value: z.union([z.string(), z.number()]).optional() }) })).optional() })).optional() });

async function opsCount(token: string, projectId: string, op: "read" | "write" | "delete", from: Date, to: Date, opts: FetchOpts): Promise<Result<number>> {
  const q = new URLSearchParams({
    filter: `metric.type="firestore.googleapis.com/document/${op}_ops_count"`,
    "interval.startTime": from.toISOString(),
    "interval.endTime": to.toISOString(),
    "aggregation.alignmentPeriod": `${Math.max(60, Math.ceil((to.getTime() - from.getTime()) / 1000))}s`,
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
  });
  const r = await callJson("Cloud Monitoring", `https://monitoring.googleapis.com/v3/projects/${pid(projectId)}/timeSeries?${q}`, { token }, opts);
  if (!r.ok) return r;
  const p = seriesSchema.safeParse(r.data);
  if (!p.success) return formatFailure("Cloud Monitoring", "the Firestore usage");
  return { ok: true, data: (p.data.timeSeries ?? []).flatMap((s) => s.points ?? []).reduce((n, pt) => n + Number(pt.value.int64Value ?? 0), 0) };
}

export async function firestoreOps(token: string, projectId: string, from: Date, to: Date, opts: FetchOpts = {}): Promise<Result<{ reads: number; writes: number; deletes: number }>> {
  const [reads, writes, deletes] = await Promise.all((["read", "write", "delete"] as const).map((op) => opsCount(token, projectId, op, from, to, opts)));
  for (const r of [reads, writes, deletes]) if (!r.ok) return r;
  return { ok: true, data: { reads: (reads as { data: number }).data, writes: (writes as { data: number }).data, deletes: (deletes as { data: number }).data } };
}
