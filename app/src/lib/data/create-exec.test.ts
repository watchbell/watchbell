import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RowLike } from "@/lib/create/flow";

// Stage 6 create requests, the per-type executors: the live checks, the re-check at approval and the single create
// call, against a fake fetch that records every request (nothing reaches a provider).

const h = vi.hoisted(() => ({ loadTarget: vi.fn(), loadAccount: vi.fn(), readCreateGrant: vi.fn() }));
vi.mock("@/lib/data/provider-action-db", () => ({ loadTarget: h.loadTarget }));
vi.mock("@/lib/data/zone-refresh", () => ({ refreshZoneRecords: vi.fn() }));
vi.mock("@/lib/data/create-db", () => ({ loadAccount: h.loadAccount, readCreateGrant: h.readCreateGrant }));

import { dnsExecutor, firebaseExecutor, FIREBASE_GRANT_MISSING, generateDbPassword, neonExecutor, supabaseExecutor } from "./create-exec";

type Call = { method: string; url: string; body: unknown };
type Route = (c: Call) => { status?: number; json?: unknown } | undefined;
function fake(route: Route) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? (init.body.startsWith("{") ? JSON.parse(init.body) : init.body) : init.body instanceof URLSearchParams ? init.body.toString() : null;
    const c = { method: init.method ?? "GET", url, body };
    calls.push(c);
    const a = route(c);
    if (!a) throw new Error(`Unexpected request: ${c.method} ${url}`);
    return new Response(a.json === undefined ? null : JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, f, writes: () => calls.filter((c) => c.method !== "GET" && !c.url.startsWith("https://oauth2.googleapis.com/token")) };
}
const row = (o: Partial<RowLike>): RowLike => ({ id: "r1", type: "dns_record", status: "running", inputs: {} as never, requestedBy: "m1", accountId: "a1", targetResourceId: "t1", targetLabel: "x", expiresAt: new Date(Date.now() + 1e6), ...o });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("DNS record", () => {
  const ZONE = "0123456789abcdef0123456789abcdef";
  beforeEach(() => h.loadTarget.mockResolvedValue({ resource: { id: "t1", name: "example.com", externalId: ZONE }, account: { id: "a1" }, token: "cf_tok" }));
  const list = (records: unknown[]) => ({ json: { success: true, result: records, result_info: { page: 1, total_pages: 1 } } });
  const inputs = { zoneName: "example.com", type: "CNAME", name: "shop.example.com", content: "cname.vercel-dns.com", ttl: 1, proxied: false };

  it("prepare: validates, then reads the live list; a taken name is refused", async () => {
    const { f, writes } = fake((c) => (c.method === "GET" ? list([{ id: "x", type: "A", name: "shop.example.com", content: "1.1.1.1" }]) : undefined));
    expect(await dnsExecutor({ fetch: f }).prepare("t1", { type: "CNAME", name: "shop", content: "cname.vercel-dns.com" })).toMatchObject({ ok: false, error: expect.stringContaining("can't share") });
    expect(writes()).toEqual([]);
  });
  it("run: the re-check (GET list) then exactly one POST /zones/{zone}/dns_records", async () => {
    const { calls, f } = fake((c) => (c.method === "GET" ? list([]) : { json: { success: true, result: { id: "new1", ...inputs } } }));
    const r = await dnsExecutor({ fetch: f }).run(row({ inputs: inputs as never }));
    expect(r).toMatchObject({ ok: true, result: { id: "new1", name: "shop.example.com" } });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /client/v4/zones/${ZONE}/dns_records`, `POST /client/v4/zones/${ZONE}/dns_records`,
    ]);
  });
  it("run: refreshes that zone's records after the create; a failing refresh never fails it", async () => {
    const { f } = fake((c) => (c.method === "GET" ? list([]) : { json: { success: true, result: { id: "new1", ...inputs } } }));
    const ok = vi.fn().mockResolvedValue(true);
    const r1 = await dnsExecutor({ fetch: f, refreshZone: ok }).run(row({ inputs: inputs as never }));
    expect(ok).toHaveBeenCalledWith("t1", "cf_tok", ZONE, expect.anything());
    expect(r1).toMatchObject({ ok: true, message: expect.stringContaining("now") });
    const bad = vi.fn().mockRejectedValue(new Error("boom"));
    const r2 = await dnsExecutor({ fetch: f, refreshZone: bad }).run(row({ inputs: inputs as never }));
    expect(bad).toHaveBeenCalled();
    expect(r2).toMatchObject({ ok: true, result: { id: "new1" }, message: expect.stringContaining("hourly read") });
  });
  it("run: no refresh when the create is refused", async () => {
    const { f } = fake((c) => (c.method === "GET" ? list([{ id: "x", type: "TXT", name: "shop.example.com" }]) : undefined));
    const refresh = vi.fn();
    await dnsExecutor({ fetch: f, refreshZone: refresh }).run(row({ inputs: inputs as never }));
    expect(refresh).not.toHaveBeenCalled();
  });
  it("run: the name taken since the request → refused at re-check, no POST", async () => {
    const { f, writes } = fake((c) => (c.method === "GET" ? list([{ id: "x", type: "TXT", name: "shop.example.com" }]) : undefined));
    expect(await dnsExecutor({ fetch: f }).run(row({ inputs: inputs as never }))).toMatchObject({ ok: false, checked: true });
    expect(writes()).toEqual([]);
  });
});

describe("Neon branch", () => {
  beforeEach(() => h.loadTarget.mockResolvedValue({ resource: { id: "t1", name: "db-b", externalId: "proj-1" }, account: { id: "a1" }, token: "neon" }));
  const branches = (n: number) => ({ json: { branches: Array.from({ length: n }, (_, i) => ({ id: `br-a-${i}`, name: i ? `b${i}` : "main", default: i === 0 })) } });

  it("prepare: names the parent and the branch count", async () => {
    const { f } = fake((c) => (c.method === "GET" ? branches(2) : undefined));
    expect(await neonExecutor({ fetch: f }).prepare("t1", { name: "p1", parentId: "br-a-0" })).toMatchObject({ ok: true, p: { inputs: { parentName: "main", name: "p1" }, cost: expect.stringContaining("3 of 10") } });
  });
  it("run: at 10 branches the re-check refuses and nothing is created", async () => {
    const { f, writes } = fake((c) => (c.method === "GET" ? branches(10) : undefined));
    expect(await neonExecutor({ fetch: f }).run(row({ type: "neon_branch", inputs: { name: "p1", parentId: "br-a-0" } as never }))).toMatchObject({ ok: false, checked: true, error: expect.stringContaining("10") });
    expect(writes()).toEqual([]);
  });
  it("run: one POST with endpoints: []", async () => {
    const { f, writes } = fake((c) => (c.method === "GET" ? branches(1) : { status: 201, json: { branch: { id: "br-new-1", name: "p1" } } }));
    expect(await neonExecutor({ fetch: f }).run(row({ type: "neon_branch", inputs: { name: "p1", parentId: "br-a-0" } as never }))).toMatchObject({ ok: true });
    expect(writes()).toEqual([{ method: "POST", url: "https://console.neon.tech/api/v2/projects/proj-1/branches", body: { branch: { name: "p1", parent_id: "br-a-0" }, endpoints: [] } }]);
  });
});

describe("Supabase project", () => {
  beforeEach(() => h.loadAccount.mockResolvedValue({ id: "a1", label: "utama", token: "sbp_t" }));
  const inputs = { orgSlug: "acme", orgName: "Acme", name: "shop", region: "ap-southeast-1" };
  const api = (plans: Record<string, number | string | null>, projects: unknown[] = []) => (c: Call) => {
    const p = new URL(c.url).pathname;
    if (c.method === "GET" && p === "/v1/organizations") return { json: [{ slug: "acme", name: "Acme" }, { slug: "paid", name: "Paid" }] };
    if (c.method === "GET" && p === "/v1/projects") return { json: projects };
    const m = /^\/v1\/organizations\/(.+)$/.exec(p);
    if (c.method === "GET" && m) {
      const v = plans[m[1]];
      return typeof v === "number" ? { status: v } : { json: { id: m[1], name: m[1], plan: v, opt_in_tags: [], allowed_release_channels: [] } };
    }
    if (c.method === "POST" && p === "/v1/projects") return { status: 201, json: { id: "newref", ref: "newref", name: "shop", status: "COMING_UP", region: "ap-southeast-1", created_at: "x" } };
    return undefined;
  };
  const proj = (orgSlug: string, status: string, name = "p") => ({ ref: `r${name}`, name, region: "x", created_at: "x", status, organization_slug: orgSlug });

  it("a paid organization is refused, at request and at approval, with no POST", async () => {
    const { f, writes } = fake(api({ acme: "pro" }));
    expect(await supabaseExecutor({ fetch: f }).prepare("a1", { orgSlug: "acme", name: "shop", region: "ap-southeast-1" })).toMatchObject({ ok: false, error: expect.stringContaining("pro plan") });
    expect(await supabaseExecutor({ fetch: f }).run(row({ type: "supabase_project", inputs: inputs as never }))).toMatchObject({ ok: false, checked: true });
    expect(writes()).toEqual([]);
  });
  it("an unreadable plan is refused (never treated as free)", async () => {
    const { f, writes } = fake(api({ acme: 500 }));
    expect(await supabaseExecutor({ fetch: f }).run(row({ type: "supabase_project", inputs: inputs as never }))).toMatchObject({ ok: false, checked: true, error: expect.stringContaining("couldn't read") });
    expect(writes()).toEqual([]);
  });
  it("2 active free projects already: refused; a paid org's projects don't count", async () => {
    const full = fake(api({ acme: "free", paid: "pro" }, [proj("acme", "ACTIVE_HEALTHY", "a"), proj("acme", "ACTIVE_HEALTHY", "b")]));
    expect(await supabaseExecutor({ fetch: full.f }).run(row({ type: "supabase_project", inputs: inputs as never }))).toMatchObject({ ok: false, error: expect.stringContaining("free limit is 2") });
    expect(full.writes()).toEqual([]);
    const ok = fake(api({ acme: "free", paid: "pro" }, [proj("acme", "ACTIVE_HEALTHY", "a"), proj("paid", "ACTIVE_HEALTHY", "b"), proj("acme", "INACTIVE", "c")]));
    const r = await supabaseExecutor({ fetch: ok.f }).run(row({ type: "supabase_project", inputs: inputs as never }));
    expect(r).toMatchObject({ ok: true, result: { id: "newref", name: "shop" }, secret: expect.stringMatching(/^[A-Za-z0-9]{32}$/) });
    expect(ok.writes()).toHaveLength(1);
    const secret = (r as { secret: string }).secret;
    expect(ok.writes()[0].body).toMatchObject({ db_pass: secret, organization_slug: "acme" });
    // The password is in the one request body and the approver's answer, never in the result that is stored.
    expect(JSON.stringify((r as { result: unknown }).result)).not.toContain(secret);
  });
  it("the password generator gives 32 strong characters each time", () => {
    const a = generateDbPassword();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(generateDbPassword()).not.toBe(a);
  });
});

describe("Firebase project", () => {
  const env = { GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec" };
  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET);
    h.readCreateGrant.mockResolvedValue({ refreshToken: "1//rt", connectedAt: "x" });
  });
  const inputs = { projectId: "my-app-2026", displayName: "My app" };
  const google = (o: { projects?: unknown[]; createOp?: unknown; crmDone?: boolean; fb?: { status?: number; json?: unknown }; fbDone?: boolean } = {}) => (c: Call) => {
    const u = new URL(c.url);
    if (u.host === "oauth2.googleapis.com") return { json: { access_token: "ya29.x" } };
    if (c.method === "GET" && u.pathname === "/v3/projects:search") return { json: { projects: o.projects ?? [] } };
    if (c.method === "POST" && u.pathname === "/v3/projects") return { json: o.createOp ?? { name: "operations/cp.1", done: false } };
    if (c.method === "GET" && u.pathname === "/v3/operations/cp.1") return { json: { name: "operations/cp.1", done: o.crmDone ?? true } };
    if (c.method === "POST" && u.pathname === "/v1beta1/projects/my-app-2026:addFirebase") return o.fb ?? { json: { name: "operations/workflows/w1", done: false } };
    if (c.method === "GET" && u.pathname === "/v1beta1/operations/workflows/w1") return { json: { name: "operations/workflows/w1", done: o.fbDone ?? true } };
    return undefined;
  };
  const opts = (f: typeof fetch) => ({ fetch: f, sleep: async () => undefined, pollTries: 2 });

  it("without the Owner's Google grant nothing is called", async () => {
    h.readCreateGrant.mockResolvedValue(null);
    const { calls, f } = fake(() => undefined);
    expect(await firebaseExecutor(opts(f)).prepare("", inputs)).toEqual({ ok: false, error: FIREBASE_GRANT_MISSING });
    expect(await firebaseExecutor(opts(f)).run(row({ type: "firebase_project", inputs: inputs as never }))).toMatchObject({ ok: false, checked: true });
    expect(calls).toEqual([]);
  });
  it("an id the owner already has, or the quota reached, is refused with no write", async () => {
    const { f, writes } = fake(google({ projects: [{ projectId: "my-app-2026", state: "ACTIVE" }] }));
    expect(await firebaseExecutor(opts(f)).run(row({ type: "firebase_project", inputs: inputs as never }))).toMatchObject({ ok: false, checked: true });
    const many = fake(google({ projects: Array.from({ length: 10 }, (_, i) => ({ projectId: `p-${i}xxxxx`, state: "ACTIVE" })) }));
    expect(await firebaseExecutor(opts(many.f)).prepare("", inputs)).toMatchObject({ ok: false, error: expect.stringContaining("quota") });
    expect([...writes(), ...many.writes()]).toEqual([]);
  });
  it("creates the project (no billing), waits for it, then adds Firebase: exactly those two POSTs", async () => {
    const { f, writes } = fake(google());
    expect(await firebaseExecutor(opts(f)).run(row({ type: "firebase_project", inputs: inputs as never }))).toMatchObject({ ok: true, result: { id: "my-app-2026" }, message: expect.stringContaining("Spark") });
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://cloudresourcemanager.googleapis.com/v3/projects",
      "POST https://firebase.googleapis.com/v1beta1/projects/my-app-2026:addFirebase",
    ]);
    expect(writes()[0].body).toEqual({ projectId: "my-app-2026", displayName: "My app" });
    expect(JSON.stringify(writes())).not.toMatch(/billing/i);
  });
  it("if the project isn't ready in time, Firebase isn't added and the owner is told how to finish", async () => {
    const { f, writes } = fake(google({ crmDone: false }));
    expect(await firebaseExecutor(opts(f)).run(row({ type: "firebase_project", inputs: inputs as never }))).toMatchObject({ ok: true, result: { note: "firebase-pending" }, message: expect.stringContaining("Add project") });
    expect(writes()).toHaveLength(1);
  });
  it("addFirebase refused (API off or terms not accepted): the project stays, the message says what to do", async () => {
    const { f } = fake(google({ fb: { status: 403, json: { error: { status: "PERMISSION_DENIED", message: "x" } } } }));
    expect(await firebaseExecutor(opts(f)).run(row({ type: "firebase_project", inputs: inputs as never }))).toMatchObject({ ok: true, result: { note: "firebase-pending" }, message: expect.stringContaining("Firebase Management API") });
  });
});
