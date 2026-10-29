import { describe, expect, it, vi } from "vitest";
import { PROVIDERS_COPY } from "@/lib/copy/edition";
import { authHeaders, keyHint, LOCAL_URL, METADATA_URL, PRESETS, providerSlug, SELFHOST_BLOCKED, SELFHOST_URL, validateForm } from "./presets";
import { defaultConnection, isGatewayModel, isOfferedModel, pickDefaultModel, publicModelName, routeModel, splitModelId, testCandidates, type RoutableConnection } from "./routing";

// A made-up key in the AIza format, assembled at run time so no key-shaped literal sits in the source (GitHub's secret
// scanning flagged the earlier literal on the public repo, 29 Oct). The test only checks the format and the hint.
const FAKE_GOOGLE_KEY = ["AI", "za"].join("") + "Fake0TestKey".padEnd(32, "x") + "k3Q";

const gem = (over: Partial<RoutableConnection> = {}): RoutableConnection => ({
  id: "p-gem", slug: "gemini", enabled: true, isDefault: true,
  models: [
    { id: "gemini-3.8-flash", upstream: "gemini-3.8-flash", enabled: true },
    { id: "gemini-2.5-pro", upstream: "gemini-2.5-pro", enabled: false },
    { id: "antigravity-preview-latest", upstream: "antigravity-preview-latest", enabled: true },
  ],
  ...over,
});
const custom = (over: Partial<RoutableConnection> = {}): RoutableConnection => ({
  id: "p-cus", slug: "my-llm", enabled: true, isDefault: false,
  models: [{ id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: true }],
  ...over,
});

describe("presets", () => {
  it("offers Gemini and Custom only (owner: full Gemini), Custom behind Advanced", () => {
    expect(Object.keys(PRESETS)).toEqual(["gemini", "cloudflare", "custom"]);
    expect(PRESETS.cloudflare.baseUrl({ apiKey: "t", accountId: "abc" })).toBe("https://api.cloudflare.com/client/v4/accounts/abc/ai/v1");
    expect(PRESETS.gemini.advanced).toBe(false);
    expect(PRESETS.custom.advanced).toBe(true);
    expect(PRESETS.gemini.baseUrl({ apiKey: "x" })).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });
  it("sends Gemini keys as x-goog-api-key (AQ. auth keys too) and custom keys as Bearer", () => {
    expect(authHeaders("gemini", "AQ.abc")).toEqual({ "x-goog-api-key": "AQ.abc" });
    expect(authHeaders("custom", "sk-1")).toEqual({ Authorization: "Bearer sk-1" });
    expect(authHeaders("cloudflare", "cf-1")).toEqual({ Authorization: "Bearer cf-1" });
  });
  it("hints the last 3 characters only", () => {
    expect(keyHint("AQ.Fake0TstKxyz123")).toBe("AQ.…123");
    expect(keyHint(FAKE_GOOGLE_KEY)).toBe("AIza…k3Q");
    expect(keyHint("sk-secret-zzz")).toBe("…zzz");
  });
  it("accepts AQ. and AIza Gemini keys, refuses anything else", () => {
    expect(validateForm("gemini", { apiKey: "AQ.Fake0TstK1234567890abcdefghij" }).ok).toBe(true);
    expect(validateForm("gemini", { apiKey: `  ${FAKE_GOOGLE_KEY} ` }).ok).toBe(true);
    expect(validateForm("gemini", { apiKey: "sk-ant-123" })).toEqual({ ok: false, fieldErrors: { apiKey: expect.stringContaining("AQ.") } });
  });
  it("custom needs a name, a public https base URL and a key", () => {
    const ok = validateForm("custom", { name: "My LLM", baseUrl: "https://llm.example.com/v1/", apiKey: "sk-12345678" });
    expect(ok).toEqual({ ok: true, value: { name: "My LLM", baseUrl: "https://llm.example.com/v1", secret: { apiKey: "sk-12345678", baseUrl: "https://llm.example.com/v1" } } });
    const bad = validateForm("custom", { name: "gemini", baseUrl: "http://localhost:8080/v1", apiKey: "x" }, false);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && Object.keys(bad.fieldErrors).sort()).toEqual(["apiKey", "baseUrl", "name"]);
    expect(validateForm("custom", { name: "x", baseUrl: "https://10.0.0.2/v1", apiKey: "sk-12345678" }, false).ok).toBe(false);
  });
  it("cloud: a local or private base URL is refused with the reason (the edition's LOCAL_URL)", () => {
    // The private edition's text ("Watchpost runs on Vercel …") is pinned in lib/copy/edition.extras.test.ts.
    expect(LOCAL_URL).toBe(PROVIDERS_COPY.localUrl);
    for (const baseUrl of ["http://localhost:11434/v1", "https://localhost/v1", "http://127.0.0.1:1234/v1", "https://192.168.1.20/v1", "https://10.0.0.2/v1", "http://[::1]:8080/v1", "https://ollama.local/v1"]) {
      const r = validateForm("custom", { name: "Local", baseUrl, apiKey: "sk-12345678" }, false);
      expect(r, baseUrl).toEqual({ ok: false, fieldErrors: { baseUrl: LOCAL_URL } });
    }
    // Public hosts keep the general message (http, another port, a query).
    for (const baseUrl of ["http://llm.example.com/v1", "https://llm.example.com:8443/v1", "https://llm.example.com/v1?x=1", "not a url"]) {
      const r = validateForm("custom", { name: "Remote", baseUrl, apiKey: "sk-12345678" }, false);
      expect(r, baseUrl).toEqual({ ok: false, fieldErrors: { baseUrl: expect.stringContaining("Enter a public https:// URL") } });
    }
  });

  // Ruling Q11: self-host may use a provider on the user's own machine or network (Ollama, LM Studio, vLLM).
  it("self-host: loopback, private LAN, *.local and public hosts over http or https, any port", () => {
    for (const baseUrl of ["http://localhost:11434/v1", "http://192.168.1.5:1234/v1", "https://127.0.0.1/v1", "http://10.0.0.2:8000/v1", "http://172.20.1.1/v1", "http://[::1]:8080/v1", "http://[fd12::5]/v1", "http://ollama.local:11434/v1", "http://llm.example.com:8443/v1", "https://llm.example.com/v1"]) {
      const r = validateForm("custom", { name: "Local", baseUrl, apiKey: "sk-12345678" }, true);
      expect(r, baseUrl).toMatchObject({ ok: true, value: { baseUrl } });
    }
  });

  it("self-host: link-local and cloud metadata addresses, other schemes, credentials and queries are refused", () => {
    const bad = (baseUrl: string) => validateForm("custom", { name: "Local", baseUrl, apiKey: "sk-12345678" }, true);
    for (const baseUrl of ["http://169.254.169.254/", "http://169.254.1.2:80/v1", "http://[fe80::1]/v1", "http://metadata.google.internal/v1", "http://[fd00:ec2::254]/v1"]) {
      expect(bad(baseUrl), baseUrl).toEqual({ ok: false, fieldErrors: { baseUrl: METADATA_URL } });
    }
    for (const baseUrl of ["file:///etc/passwd", "ftp://192.168.1.5/v1", "http://u:p@localhost:11434/v1", "http://localhost:11434/v1?x=1", "not a url", ""]) {
      expect(bad(baseUrl), baseUrl).toEqual({ ok: false, fieldErrors: { baseUrl: SELFHOST_URL } });
    }
    // Neither public nor the user's own LAN (CGNAT, multicast, "this network", a bare name other than localhost).
    for (const baseUrl of ["http://100.64.0.1/v1", "http://224.0.0.1/v1", "http://0.0.0.0:11434/v1", "http://ollama:11434/v1"]) {
      expect(bad(baseUrl), baseUrl).toEqual({ ok: false, fieldErrors: { baseUrl: SELFHOST_BLOCKED } });
    }
    for (const m of [METADATA_URL, SELFHOST_URL, SELFHOST_BLOCKED]) expect(m).not.toMatch(/vercel/i);
  });

  it("reads the runtime mode when none is passed: self-host allows localhost, cloud and demo don't", () => {
    const form = { name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "sk-12345678" };
    try {
      vi.stubEnv("WATCHPOST_MODE", "selfhost");
      expect(validateForm("custom", form).ok).toBe(true);
      for (const m of ["cloud", "demo", ""]) {
        vi.stubEnv("WATCHPOST_MODE", m);
        expect(validateForm("custom", form)).toEqual({ ok: false, fieldErrors: { baseUrl: LOCAL_URL } });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  // Follow-up A1: Ollama and LM Studio need no key. Self-host only, and only on the user's own machine or network.
  it("self-host: a loopback or private base URL may be saved without a key", () => {
    for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://192.168.1.5:1234/v1", "http://10.0.0.2:8000/v1", "http://[::1]:8080/v1", "http://[fd12::5]/v1", "http://ollama.local:11434/v1"]) {
      for (const apiKey of ["", "   ", undefined]) {
        const r = validateForm("custom", { name: "Local", baseUrl, apiKey }, true);
        expect(r, `${baseUrl} ${JSON.stringify(apiKey)}`).toEqual({ ok: true, value: { name: "Local", baseUrl, secret: { apiKey: "", baseUrl } } });
      }
    }
    // A key that is given is still checked.
    expect(validateForm("custom", { name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "short" }, true)).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key." } });
    expect(validateForm("custom", { name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "sk-12345678" }, true)).toMatchObject({ ok: true, value: { secret: { apiKey: "sk-12345678" } } });
  });
  it("self-host: a public base URL still needs a key; so does a refused address", () => {
    for (const baseUrl of ["https://llm.example.com/v1", "http://llm.example.com:8443/v1"]) {
      expect(validateForm("custom", { name: "Remote", baseUrl, apiKey: "" }, true), baseUrl).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key." } });
    }
    expect(validateForm("custom", { name: "Meta", baseUrl: "http://169.254.169.254/v1", apiKey: "" }, true)).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key.", baseUrl: METADATA_URL } });
    expect(validateForm("custom", { name: "Lan", baseUrl: "http://ollama:11434/v1", apiKey: "" }, true)).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key.", baseUrl: SELFHOST_BLOCKED } });
    expect(validateForm("custom", { name: "Bad", baseUrl: "http://localhost:11434/v1?x=1", apiKey: "" }, true)).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key.", baseUrl: SELFHOST_URL } });
  });
  it("cloud and demo: the key rule and messages are unchanged (an empty key is refused everywhere)", () => {
    expect(validateForm("custom", { name: "Remote", baseUrl: "https://llm.example.com/v1", apiKey: "" }, false)).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key." } });
    expect(validateForm("custom", { name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "" }, false)).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key.", baseUrl: LOCAL_URL } });
    try {
      for (const m of ["cloud", "demo", ""]) {
        vi.stubEnv("WATCHPOST_MODE", m);
        expect(validateForm("custom", { name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "" }), m).toEqual({ ok: false, fieldErrors: { apiKey: "That doesn't look like a key.", baseUrl: LOCAL_URL } });
      }
      vi.stubEnv("WATCHPOST_MODE", "selfhost");
      expect(validateForm("custom", { name: "Local", baseUrl: "http://localhost:11434/v1", apiKey: "" }).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    // The presets never take an empty key.
    expect(validateForm("gemini", { apiKey: "" }, true).ok).toBe(false);
    expect(validateForm("cloudflare", { accountId: "0123456789abcdef0123456789abcdef", apiKey: "" }, true).ok).toBe(false);
  });
  it("no key: no auth header at all, and an empty hint", () => {
    expect(authHeaders("custom", "")).toEqual({});
    expect(keyHint("")).toBe("");
  });
  it("Cloudflare needs a 32-hex account id and a token", () => {
    expect(validateForm("cloudflare", { accountId: "0123456789ABCDEF0123456789abcdef", apiKey: "cf_token_000000000000000000000000000000" })).toMatchObject({ ok: true, value: { secret: { accountId: "0123456789abcdef0123456789abcdef" } } });
    const bad = validateForm("cloudflare", { accountId: "nope", apiKey: "short" });
    expect(!bad.ok && Object.keys(bad.fieldErrors).sort()).toEqual(["accountId", "apiKey"]);
  });
  it("slugs: presets use their kind, custom its name", () => {
    expect(providerSlug("gemini", "Google Gemini")).toBe("gemini");
    expect(providerSlug("custom", "My LLM!")).toBe("my-llm");
  });
});

describe("routing", () => {
  it("splits provider/model; bare ids and Gemini's models/ prefix have no provider", () => {
    expect(splitModelId("gemini/gemini-3.8-flash")).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    expect(splitModelId("gemini-3.8-flash")).toEqual({ provider: null, model: "gemini-3.8-flash" });
    expect(splitModelId("models/gemini-3.8-flash")).toEqual({ provider: null, model: "gemini-3.8-flash" });
    expect(publicModelName("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });
  it("only Gemini and Antigravity models are gateway models", () => {
    expect(isGatewayModel("gemini/gemini-3.8-flash")).toBe(true);
    expect(isGatewayModel("antigravity-preview-latest")).toBe(true);
    expect(isGatewayModel("claude-sonnet")).toBe(false);
    expect(isGatewayModel("my-llm/llama-3.3")).toBe(false);
    expect(isGatewayModel("@cf/google/gemma-3-12b-it")).toBe(true);
    expect(isGatewayModel("@cf/meta/llama-3.1-8b-instruct")).toBe(false);
    expect(isGatewayModel("gemma-3-12b-it")).toBe(false); // Gemma only through the Workers AI @cf/google ids
    expect(publicModelName("@cf/google/gemma-3-12b-it")).toBe("gemma-3-12b-it");
  });
  it("Workers AI ids: public ids drop @cf/<vendor>/ and map back; full ids also route", () => {
    const cf: RoutableConnection = { id: "p-cf", slug: "cloudflare", enabled: true, isDefault: true, models: [{ id: "gemma-3-12b-it", upstream: "@cf/google/gemma-3-12b-it", enabled: true }] };
    expect(routeModel([cf], "cloudflare/gemma-3-12b-it", null)).toMatchObject({ model: { upstream: "@cf/google/gemma-3-12b-it" }, publicId: "cloudflare/gemma-3-12b-it" });
    expect(routeModel([cf], "@cf/google/gemma-3-12b-it", null)).toMatchObject({ publicId: "cloudflare/gemma-3-12b-it" });
    expect(routeModel([{ ...cf, models: [{ id: "llama-3.1-8b-instruct", upstream: "@cf/meta/llama-3.1-8b-instruct", enabled: true }] }], "cloudflare/llama-3.1-8b-instruct", null)).toBe("model_not_enabled");
  });
  it("default model: gemini-3.8-flash, else the newest Gemma instruct model", () => {
    expect(pickDefaultModel([{ id: "gemini-2.5-pro", upstream: "gemini-2.5-pro" }, { id: "gemini-3.8-flash", upstream: "gemini-3.8-flash" }])?.id).toBe("gemini-3.8-flash");
    expect(pickDefaultModel([
      { id: "gemma-3-12b-it", upstream: "@cf/google/gemma-3-12b-it" }, { id: "gemma-4-4b-it", upstream: "@cf/google/gemma-4-4b-it" },
      { id: "gemma-4-27b-it", upstream: "@cf/google/gemma-4-27b-it" }, { id: "gemma-7b", upstream: "@cf/google/gemma-7b" },
    ])?.id).toBe("gemma-4-27b-it");
    expect(pickDefaultModel([])).toBeNull();
  });
  it("a bare id goes to the default connection", () => {
    expect(routeModel([gem(), custom()], "gemini-3.8-flash", null)).toMatchObject({ conn: { id: "p-gem" }, publicId: "gemini/gemini-3.8-flash" });
    expect(routeModel([gem(), custom()], "my-llm/gemini-2.5-flash", null)).toMatchObject({ conn: { id: "p-cus" }, model: { upstream: "gemini-2.5-flash" } });
  });
  it("no enabled connection → provider_not_connected; disabled/unknown model → model_not_enabled", () => {
    expect(routeModel([], "gemini-3.8-flash", null)).toBe("provider_not_connected");
    expect(routeModel([gem({ enabled: false })], "gemini-3.8-flash", null)).toBe("provider_not_connected");
    expect(routeModel([gem()], "gemini-2.5-pro", null)).toBe("model_not_enabled");
    expect(routeModel([gem()], "gpt-4o", null)).toBe("model_not_enabled");
    expect(routeModel([gem()], "openai/gemini-3.8-flash", null)).toBe("model_not_enabled");
    expect(routeModel([gem(), custom({ enabled: false })], "my-llm/gemini-2.5-flash", null)).toBe("provider_not_connected");
  });
  it("a key pinned to a model wins over the request; a provider pin limits bare ids to that provider", () => {
    expect(routeModel([gem(), custom()], "gemini-3.8-flash", { providerId: null, model: "my-llm/gemini-2.5-flash" })).toMatchObject({ publicId: "my-llm/gemini-2.5-flash" });
    expect(routeModel([gem(), custom()], "gemini-2.5-flash", { providerId: "p-cus", model: null })).toMatchObject({ conn: { id: "p-cus" } });
    expect(routeModel([gem(), custom()], "gemini/gemini-3.8-flash", { providerId: "p-cus", model: null })).toBe("model_not_enabled");
  });
  it("without a default, the only enabled connection is used", () => {
    expect(defaultConnection([gem({ isDefault: false })])?.id).toBe("p-gem");
    expect(defaultConnection([gem({ isDefault: false }), custom()])).toBeNull();
  });
});

describe("manual model ids (custom connections)", () => {
  const test = (over: Partial<RoutableConnection> = {}): RoutableConnection => ({
    id: "p-test", slug: "test", enabled: true, isDefault: true,
    models: [
      { id: "gemini-2.5-flash", upstream: "gemini-2.5-flash", enabled: true },
      { id: "llama-3.3", upstream: "llama-3.3", enabled: true },
      { id: "prrojects", upstream: "prrojects", enabled: true, manual: true },
      { id: "ag/gemini-x", upstream: "ag/gemini-x", enabled: true, manual: true },
      { id: "combo:v2@eu", upstream: "combo:v2@eu", enabled: false, manual: true },
    ],
    ...over,
  });
  it("manual models are offered whatever their name; listed ones keep the Google-only rule", () => {
    expect(isOfferedModel({ upstream: "prrojects", manual: true })).toBe(true);
    expect(isOfferedModel({ upstream: "prrojects" })).toBe(false);
    expect(isOfferedModel({ upstream: "gemini-2.5-flash" })).toBe(true);
  });
  it("prrojects on test is callable as test/prrojects, and bare when test is the default", () => {
    expect(routeModel([gem({ isDefault: false }), test()], "test/prrojects", null)).toMatchObject({ conn: { id: "p-test" }, model: { upstream: "prrojects" }, publicId: "test/prrojects" });
    expect(routeModel([gem({ isDefault: false }), test()], "prrojects", null)).toMatchObject({ conn: { id: "p-test" }, publicId: "test/prrojects" });
    expect(routeModel([gem(), test({ isDefault: false })], "prrojects", null)).toBe("model_not_enabled"); // the default is Gemini
    expect(routeModel([gem(), test({ isDefault: false })], "test/prrojects", null)).toMatchObject({ publicId: "test/prrojects" });
  });
  it("a listed non-Google model stays refused; a switched-off manual model is not enabled", () => {
    expect(routeModel([test()], "test/llama-3.3", null)).toBe("model_not_enabled");
    expect(routeModel([test()], "test/combo:v2@eu", null)).toBe("model_not_enabled");
  });
  it("ids with a slash: provider/<id with slashes>, and a bare id whose prefix is no connection goes to the default", () => {
    expect(routeModel([gem({ isDefault: false }), test()], "test/ag/gemini-x", null)).toMatchObject({ model: { upstream: "ag/gemini-x" }, publicId: "test/ag/gemini-x" });
    expect(routeModel([gem({ isDefault: false }), test()], "ag/gemini-x", null)).toMatchObject({ conn: { id: "p-test" }, publicId: "test/ag/gemini-x" });
    expect(routeModel([gem(), test({ isDefault: false })], "ag/gemini-x", null)).toBe("model_not_enabled");
    // An unknown prefix never strips itself to reach another model.
    expect(routeModel([gem()], "openai/gemini-3.8-flash", null)).toBe("model_not_enabled");
    expect(routeModel([test()], "other/prrojects", null)).toBe("model_not_enabled");
    // A known but switched-off prefix is still "not connected".
    expect(routeModel([gem(), test({ enabled: false })], "test/prrojects", null)).toBe("provider_not_connected");
  });
  it("pins: a key pinned to test/prrojects gets it; a provider pin routes bare ids to that connection", () => {
    expect(routeModel([gem(), test({ isDefault: false })], "gemini-3.8-flash", { providerId: null, model: "test/prrojects" })).toMatchObject({ publicId: "test/prrojects" });
    expect(routeModel([gem(), test({ isDefault: false })], "prrojects", { providerId: "p-test", model: null })).toMatchObject({ publicId: "test/prrojects" });
    expect(routeModel([gem(), test({ isDefault: false })], "ag/gemini-x", { providerId: "p-test", model: null })).toMatchObject({ publicId: "test/ag/gemini-x" });
  });
});

describe("custom servers offer every listed model (owner 14 Oct)", () => {
  const custom = { id: "c1", slug: "test", kind: "custom", enabled: true, isDefault: true, models: [{ id: "llama-3.3", upstream: "llama-3.3", enabled: true }] };
  it("a non-Google listed model routes on a custom connection, never on a preset", async () => {
    const { routeModel, isOfferedModel } = await import("./routing");
    expect(routeModel([custom], "test/llama-3.3", null)).toMatchObject({ publicId: "test/llama-3.3" });
    expect(isOfferedModel({ upstream: "llama-3.3" }, "custom")).toBe(true);
    expect(isOfferedModel({ upstream: "llama-3.3" }, "gemini")).toBe(false);
    expect(isOfferedModel({ upstream: "llama-3.3" })).toBe(false);
  });
  it("mergeListedModels on a fresh custom list turns every model on; with a list already it is the model sync's plan", async () => {
    const { mergeListedModels } = await import("./routing");
    expect(mergeListedModels([], [{ id: "x", upstream: "x" }], "custom", null)).toEqual([{ id: "x", upstream: "x", enabled: true }]);
    const now = new Date("2026-10-16T00:00:00.000Z");
    const prev = [{ id: "a", upstream: "a", enabled: true }, { id: "gone", upstream: "gone", enabled: true }];
    expect(mergeListedModels(prev, [{ id: "a", upstream: "a" }, { id: "b", upstream: "b" }], "custom", null, now)).toEqual([
      prev[0], { id: "b", upstream: "b", enabled: false, pending: true, addedAt: now.toISOString() },
      { id: "gone", upstream: "gone", enabled: false, removed: true, removedAt: now.toISOString() },
    ]);
  });
  it("mergeListedModels (presets) keeps switches and lastTest of remaining ids, drops vanished, keeps manual", async () => {
    const { mergeListedModels } = await import("./routing");
    const lastTest = { ok: true, ms: 2300, at: "2026-10-14T00:00:00.000Z" };
    const prev = [
      { id: "a", upstream: "a", enabled: false, lastTest }, { id: "gone", upstream: "gone", enabled: true },
      { id: "combo", upstream: "combo", enabled: true, manual: true },
    ];
    expect(mergeListedModels(prev, [{ id: "a", upstream: "a" }, { id: "b", upstream: "b" }], "gemini", null)).toEqual([
      { id: "a", upstream: "a", enabled: false, lastTest }, { id: "b", upstream: "b", enabled: false }, prev[2],
    ]);
    expect(mergeListedModels([], [{ id: "x", upstream: "x" }, { id: "y", upstream: "y" }], "gemini", "y")).toEqual([
      { id: "x", upstream: "x", enabled: false }, { id: "y", upstream: "y", enabled: true },
    ]);
  });
  it("staleModelLists: enabled custom connections never refreshed or older than 10 min", async () => {
    const { staleModelLists } = await import("./routing");
    const now = new Date("2026-10-14T01:00:00.000Z");
    const conns = [
      { id: "c1", kind: "custom", enabled: true }, { id: "c2", kind: "custom", enabled: true }, { id: "c3", kind: "custom", enabled: false },
      { id: "g", kind: "gemini", enabled: true }, { id: "c4", kind: "custom", enabled: true },
    ];
    const marks = { c1: new Date(now.getTime() - 9 * 60_000).toISOString(), c2: new Date(now.getTime() - 10 * 60_000).toISOString() };
    expect(staleModelLists(conns, marks, now).map((c) => c.id)).toEqual(["c2", "c4"]);
  });
});

describe("testCandidates (which models a connect/replace test tries)", () => {
  const m = (id: string) => ({ id, upstream: id });
  const listed = ["ag/claude-opus-5-5", "ag/gemini-3-flash", "combo-new", "gemini/gemini-3.8-flash", "gemini/gemini-3.8-pro"].map(m);

  it("custom: models that were on and passed their last test come first, then on ones, then Gemini Flash, then the rest; at most 3", () => {
    const previous = [
      { id: "combo-new", upstream: "combo-new", enabled: true, lastTest: { ok: true, ms: 900, at: "2026-10-14T00:00:00Z" } },
      { id: "gemini/gemini-3.8-pro", upstream: "gemini/gemini-3.8-pro", enabled: true },
      { id: "ag/claude-opus-5-5", upstream: "ag/claude-opus-5-5", enabled: true, lastTest: { ok: false, ms: 0, status: 503, error: "x", at: "2026-10-14T00:00:00Z" } },
    ];
    expect(testCandidates(listed, previous, "custom").map((x) => x.id)).toEqual(["combo-new", "gemini/gemini-3.8-pro", "gemini/gemini-3.8-flash"]);
  });

  it("custom with no history: Gemini Flash first, never the alphabetical first model by default", () => {
    expect(testCandidates(listed, [], "custom").map((x) => x.id)).toEqual(["gemini/gemini-3.8-flash", "ag/gemini-3-flash", "ag/claude-opus-5-5"]);
  });

  it("presets keep the single pickDefaultModel choice", () => {
    expect(testCandidates(listed, [], "gemini")).toEqual([pickDefaultModel(listed)]);
  });
});
