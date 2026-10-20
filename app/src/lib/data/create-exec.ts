import "server-only";
import { ENV_COPY } from "@/lib/copy/edition";
import { randomBytes } from "node:crypto";
import { driveEnv, refreshAccessToken } from "@/lib/backup/google-oauth";
import type { Executor, RowLike, RunOutcome } from "@/lib/create/flow";
import type { DnsInputs, FirebaseInputs, NeonInputs, SupabaseInputs } from "@/lib/create/types";
import { type Check, dnsCheck, firebaseCheck, neonCheck, supabaseCheck, validateDns, validateFirebase, validateNeon, validateSupabase } from "@/lib/create/validate";
import { loadAccount, readCreateGrant } from "@/lib/data/create-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import { refreshZoneRecords } from "@/lib/data/zone-refresh";
import { listDnsRecords } from "@/lib/providers/cloudflare";
import { createDnsRecord } from "@/lib/providers/cloudflare-create";
import { addFirebase, createGcpProject, getOperation, listGcpProjects, type Operation } from "@/lib/providers/gcp-create";
import type { Failure, Result } from "@/lib/providers/http";
import { listBranches } from "@/lib/providers/neon";
import { createBranch } from "@/lib/providers/neon-create";
import { listProjects, orgPlan } from "@/lib/providers/supabase";
import { createProject, listOrganizations } from "@/lib/providers/supabase-create";

// Stage 6 create requests, the per-type server half. prepare() runs at request time: validation, then the live
// free-tier check (reads only). run() runs once per approval: the same live check again, then exactly ONE create call
// (Firebase: the project, then Firebase on it, the two halves of one create). Nothing here updates or deletes.
// `fetch` is injectable so the tests pin every request the whole flow makes.

export type ExecOpts = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; pollMs?: number; pollTries?: number; refreshZone?: typeof refreshZoneRecords };

const GONE = "This isn't watched any more, or its credential can't be read. Reload the page.";
const refuse = (error: string): RunOutcome => ({ ok: false, error, checked: true });
const noAnswer = (r: Failure) => r.kind === "transient" && r.status === undefined;
const failedCreate = (r: Failure, what: string): RunOutcome => noAnswer(r)
  ? { ok: false, checked: false, maybe: true, error: `${r.error} The ${what} may still have been created; check the provider's dashboard before asking again.` }
  : { ok: false, checked: false, error: r.error };

// ---------- Cloudflare DNS record ----------
async function dnsLive(token: string, zoneId: string, i: Pick<DnsInputs, "name" | "type">, o: ExecOpts): Promise<Check> {
  const live = await listDnsRecords(token, zoneId, { fetch: o.fetch });
  if (!live.ok) return { ok: false, error: live.kind === "scope" ? "This Cloudflare token can't read DNS records; add \"Zone → DNS → Read\" and \"Zone → DNS → Edit\"." : `Couldn't read the zone's records just now: ${live.error}` };
  return dnsCheck(live.data.records, i, live.data.truncated);
}

export const dnsExecutor = (o: ExecOpts = {}): Executor => ({
  async prepare(zoneResourceId, raw) {
    const t = await loadTarget(zoneResourceId, "zone");
    if (!t || !t.resource.externalId) return { ok: false, error: GONE };
    const v = validateDns(raw, t.resource.name);
    if (!v.ok) return v;
    const c = await dnsLive(t.token, t.resource.externalId, v.inputs, o);
    if (!c.ok) return { ok: false, error: c.error, field: "name" };
    return { ok: true, p: { inputs: v.inputs, accountId: t.account.id, targetResourceId: t.resource.id, targetLabel: t.resource.name, cost: c.cost } };
  },
  async run(row) {
    const i = row.inputs as DnsInputs;
    const t = row.targetResourceId ? await loadTarget(row.targetResourceId, "zone") : null;
    if (!t || !t.resource.externalId) return refuse(GONE);
    const c = await dnsLive(t.token, t.resource.externalId, i, o);
    if (!c.ok) return refuse(c.error);
    const r = await createDnsRecord(t.token, t.resource.externalId, { type: i.type, name: i.name, content: i.content, ttl: i.ttl, proxied: i.proxied }, { fetch: o.fetch });
    if (!r.ok) return { ok: false, checked: false, error: r.error, ...(r.maybe ? { maybe: true } : {}) };
    // The record exists now; a failed refresh (it never throws, and a throw is swallowed too) is left to the hourly read.
    let shown = false;
    try {
      shown = !!(await (o.refreshZone ?? refreshZoneRecords)(t.resource.id, t.token, t.resource.externalId, { fetch: o.fetch }));
    } catch {
      shown = false;
    }
    return { ok: true, result: { id: r.data.id, name: r.data.name }, message: `Added ${i.type} ${r.data.name}. ${shown ? "It shows on the DNS page now." : "It shows on the DNS page after the next hourly read."}` };
  },
});

// ---------- Neon branch ----------
export const neonExecutor = (o: ExecOpts = {}): Executor => ({
  async prepare(projectResourceId, raw) {
    const t = await loadTarget(projectResourceId, "neon_project");
    if (!t) return { ok: false, error: GONE };
    const v = validateNeon(raw, t.resource.name);
    if (!v.ok) return v;
    const live = await listBranches(t.token, t.resource.externalId, { fetch: o.fetch });
    if (!live.ok) return { ok: false, error: `Couldn't read this project's branches just now: ${live.error}` };
    const c = neonCheck(live.data, v.inputs);
    if (!c.ok) return { ok: false, error: c.error, field: "name" };
    const parentName = live.data.find((b) => b.id === v.inputs.parentId)?.name ?? v.inputs.parentId;
    return { ok: true, p: { inputs: { ...v.inputs, parentName }, accountId: t.account.id, targetResourceId: t.resource.id, targetLabel: t.resource.name, cost: c.cost } };
  },
  async run(row) {
    const i = row.inputs as NeonInputs;
    const t = row.targetResourceId ? await loadTarget(row.targetResourceId, "neon_project") : null;
    if (!t) return refuse(GONE);
    const live = await listBranches(t.token, t.resource.externalId, { fetch: o.fetch });
    if (!live.ok) return refuse(`Couldn't read this project's branches just now: ${live.error}`);
    const c = neonCheck(live.data, i);
    if (!c.ok) return refuse(c.error);
    const r = await createBranch(t.token, t.resource.externalId, { name: i.name, parentId: i.parentId }, { fetch: o.fetch });
    if (!r.ok) return r.kind === "busy" ? { ok: false, checked: false, error: r.error } : failedCreate(r, "branch");
    return { ok: true, result: { id: r.data.id, name: r.data.name }, message: `Branch ${r.data.name} created without a compute. It shows on the Neon page within 5 minutes; Wake it there when you need it (that uses CU-hours).` };
  },
});

// ---------- Supabase project ----------
// The live facts: the org must be visible, its plan "free" (read now), and the active projects across free orgs < 2.
async function supabaseLive(token: string, i: Pick<SupabaseInputs, "orgSlug" | "name">, o: ExecOpts): Promise<(Check & { orgName?: string })> {
  const orgs = await listOrganizations(token, { fetch: o.fetch });
  if (!orgs.ok) return { ok: false, error: orgs.kind === "scope" ? "This Supabase token can't list organizations; add the \"organizations_read\" permission." : `Couldn't read the organizations just now: ${orgs.error}` };
  const org = orgs.data.find((x) => x.slug === i.orgSlug);
  if (!org) return { ok: false, error: "This token can't see that organization any more." };
  const projects = await listProjects(token, { fetch: o.fetch });
  if (!projects.ok) return { ok: false, error: `Couldn't count this account's projects just now: ${projects.error}` };
  // Every org's plan, read live. An unreadable plan never counts as paid (so it can only make the slot count stricter),
  // and the target org's unreadable plan refuses the create.
  const slugs = [...new Set([i.orgSlug, ...projects.data.map((p) => p.orgSlug)].filter(Boolean))];
  const plans = await Promise.all(slugs.map(async (s) => [s, await orgPlan(token, s, { fetch: o.fetch })] as const));
  const planOf = new Map(plans.map(([s, r]) => [s, r.ok ? r.data : null]));
  const paid = new Set(plans.filter(([, r]) => r.ok && r.data !== null && r.data !== "free").map(([s]) => s));
  const target = plans.find(([s]) => s === i.orgSlug)?.[1];
  if (target && !target.ok && target.kind === "scope") {
    return { ok: false, error: "This Supabase token can't read organization plans; add \"organization_admin_read\" so the console can confirm the free plan." };
  }
  const c = supabaseCheck({ plan: planOf.get(i.orgSlug) ?? null, projects: projects.data, paidOrgs: paid }, i);
  return c.ok ? { ...c, orgName: org.name } : c;
}

// 32 characters from [A-Za-z0-9]: strong, and safe in a connection string. Generated at approval, never stored.
export function generateDbPassword(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(64);
  let out = "";
  for (const b of bytes) {
    if (b >= 248) continue; // 248 = 4 × 62: no modulo bias
    out += abc[b % 62];
    if (out.length === 32) break;
  }
  return out.length === 32 ? out : generateDbPassword();
}

export const supabaseExecutor = (o: ExecOpts = {}): Executor => ({
  async prepare(accountId, raw) {
    const a = await loadAccount(accountId, "supabase");
    if (!a) return { ok: false, error: GONE };
    const v = validateSupabase(raw);
    if (!v.ok) return v;
    const c = await supabaseLive(a.token, v.inputs, o);
    if (!c.ok) return { ok: false, error: c.error, field: "orgSlug" };
    return { ok: true, p: { inputs: { ...v.inputs, orgName: c.orgName ?? v.inputs.orgSlug }, accountId: a.id, targetResourceId: null, targetLabel: a.label, cost: c.cost } };
  },
  async run(row) {
    const i = row.inputs as SupabaseInputs;
    const a = row.accountId ? await loadAccount(row.accountId, "supabase") : null;
    if (!a) return refuse(GONE);
    const c = await supabaseLive(a.token, i, o);
    if (!c.ok) return refuse(c.error);
    const dbPass = generateDbPassword();
    const r = await createProject(a.token, { orgSlug: i.orgSlug, name: i.name, region: i.region, dbPass }, { fetch: o.fetch });
    if (!r.ok) return failedCreate(r, "project");
    return {
      ok: true, secret: dbPass, result: { id: r.data.ref, name: r.data.name },
      message: `Project ${r.data.name} is being set up (about 2 minutes). Copy its database password now: the console doesn't keep it and can't show it again.`,
    };
  },
});

// ---------- Firebase project ----------
export const FIREBASE_GRANT_MISSING = "Connect Google (create projects) on the Firebase page first.";

async function googleToken(o: ExecOpts): Promise<Result<string>> {
  const env = driveEnv();
  if (!env) return { ok: false, kind: "auth", error: ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true) };
  const grant = await readCreateGrant();
  if (!grant) return { ok: false, kind: "auth", error: FIREBASE_GRANT_MISSING };
  const t = await refreshAccessToken(env, grant.refreshToken, { fetch: o.fetch });
  if (!t.ok) return { ok: false, kind: "auth", error: t.kind === "revoked" ? "Google ended the create-projects grant (Testing mode lasts 7 days, or it was removed). Connect Google again on the Firebase page." : t.error };
  return { ok: true, data: t.accessToken };
}

async function firebaseLive(token: string, i: Pick<FirebaseInputs, "projectId">, o: ExecOpts): Promise<Check> {
  const list = await listGcpProjects(token, { fetch: o.fetch });
  if (!list.ok) {
    return { ok: false, error: list.kind === "scope" ? "Google refused the project list: enable the Cloud Resource Manager API on the OAuth client's Google Cloud project." : `Couldn't read your Google Cloud projects just now: ${list.error}` };
  }
  return firebaseCheck(list.data, i);
}

async function waitFor(token: string, api: "crm" | "firebase", op: Operation, o: ExecOpts): Promise<Result<Operation>> {
  let cur = op;
  const tries = o.pollTries ?? 6;
  for (let n = 0; !cur.done && n < tries; n++) {
    await (o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(o.pollMs ?? 2000);
    const r = await getOperation(token, api, cur.name, { fetch: o.fetch });
    if (!r.ok) return r;
    cur = r.data;
  }
  return { ok: true, data: cur };
}

export const firebaseExecutor = (o: ExecOpts = {}): Executor => ({
  async prepare(_target, raw) {
    const v = validateFirebase(raw);
    if (!v.ok) return v;
    const t = await googleToken(o);
    if (!t.ok) return { ok: false, error: t.error };
    const c = await firebaseLive(t.data, v.inputs, o);
    if (!c.ok) return { ok: false, error: c.error, field: "projectId" };
    return { ok: true, p: { inputs: v.inputs, accountId: null, targetResourceId: null, targetLabel: "Google account", cost: c.cost } };
  },
  async run(row: RowLike) {
    const i = row.inputs as FirebaseInputs;
    const t = await googleToken(o);
    if (!t.ok) return refuse(t.error);
    const c = await firebaseLive(t.data, i, o);
    if (!c.ok) return refuse(c.error);
    const created = await createGcpProject(t.data, i, { fetch: o.fetch });
    if (!created.ok) {
      const f = failedCreate(created, "project");
      return created.kind === "scope" ? { ...f, error: "Google refused to create the project (permission or quota). Check the project quota in the Google Cloud console." } : f;
    }
    const half = (why: string): RunOutcome => ({
      ok: true, result: { id: i.projectId, name: i.displayName, note: "firebase-pending" },
      message: `Google Cloud project ${i.projectId} was created without billing, but Firebase isn't on it yet (${why}). Open the Firebase console → Add project → choose ${i.projectId} to finish; nothing else is needed.`,
    });
    const p = await waitFor(t.data, "crm", created.data, o);
    if (!p.ok || !p.data.done) return half("Google was still creating the project");
    if (p.data.error) return { ok: false, checked: false, error: `Google couldn't create the project (${p.data.error}). Check the Google Cloud console; nothing was charged.` };
    const fb = await addFirebase(t.data, i.projectId, { fetch: o.fetch });
    if (!fb.ok) return half(fb.kind === "scope" ? "enable the Firebase Management API on the OAuth client's project, and accept the Firebase terms once in the Firebase console" : fb.error);
    const f = await waitFor(t.data, "firebase", fb.data, o);
    if (!f.ok || !f.data.done) return { ok: true, result: { id: i.projectId, name: i.displayName }, message: `Created ${i.projectId}; Firebase is still being added (a minute or two). It stays on the free Spark plan: no billing account is attached.` };
    if (f.data.error) return half(`Firebase answered ${f.data.error}`);
    return { ok: true, result: { id: i.projectId, name: i.displayName }, message: `Created Firebase project ${i.projectId} on the free Spark plan (no billing account). Watch it by adding a viewer service account for it in Connections.` };
  },
});

export const EXECUTORS = { dns_record: dnsExecutor, neon_branch: neonExecutor, supabase_project: supabaseExecutor, firebase_project: firebaseExecutor } as const;
