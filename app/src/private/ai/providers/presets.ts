import { PROVIDERS_COPY } from "@/lib/copy/edition";
import { mode } from "@/lib/mode";
import { blockedHostname, localProviderHost, urlProblem } from "@/lib/net/public-host";
import type { ProviderKind } from "@/private/ai/types";

// Provider presets (Task 3). Owner rulings 13 Oct: Google models only. Presets: Google Gemini (API key from AI Studio,
// legacy "AIza…" or the new "AQ." auth keys), Cloudflare Workers AI (owner 08:10: its Google Gemma models, for
// answers around the clock while the Gemini project is denied) and a Custom OpenAI-compatible server behind "Advanced".
// Groq/OpenRouter stay valid ProviderKind values in the schema but have no preset, so they can't be connected.
//
// Verified 13 Oct 2026 (read-only docs, no real calls):
// - https://ai.google.dev/gemini-api/docs/openai: OpenAI-compatible base
//   https://generativelanguage.googleapis.com/v1beta/openai, POST /chat/completions (stream supported, the docs' own
//   example passes stream_options.include_usage), GET /models.
// - https://ai.google.dev/gemini-api/docs/api-key: keys are sent in the `x-goog-api-key` header (the only form the
//   REST examples use); new AI Studio keys are auth keys ("AQ." prefix). The OpenAI page shows `Authorization: Bearer`,
//   but forum reports show "AQ." keys refused as an OAuth token type there, while the owner's own models.list with
//   x-goog-api-key and an "AQ." key worked (controller finding 07:55). So Gemini calls send x-goog-api-key only.
// - https://ai.google.dev/gemini-api/docs/rate-limits + troubleshooting: no x-ratelimit-* headers documented; 429
//   RESOURCE_EXHAUSTED (body may carry RetryInfo.retryDelay "53s"; the OpenAI-compatible endpoint may wrap the error in
//   a JSON array). Quota is therefore counted by Watchbell against owner-entered limits ("own").
// - https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/ (updated 18 Sep 2026): base
//   https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1, POST /chat/completions, Authorization: Bearer
//   {api_token}; ids "@cf/{vendor}/{model}". No /models there: models come from
//   GET /client/v4/accounts/{account_id}/ai/models/search?task=Text Generation (token with Workers AI Read; docs
//   https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/). No rate-limit headers
//   documented (free tier is counted in neurons per day), so quota is "own".

export type ProviderSecret = { apiKey: string; accountId?: string; baseUrl?: string };
export type PresetKind = Extract<ProviderKind, "gemini" | "cloudflare" | "custom">;
export const PRESET_KINDS = ["gemini", "cloudflare", "custom"] as const satisfies readonly PresetKind[];

export type Preset = {
  name: string;
  baseUrl: (secret: ProviderSecret) => string;
  secretFields: ("apiKey" | "accountId" | "baseUrl")[];
  modelsPath: string;
  listModels: "gemini-native" | "cloudflare-search" | "openai";
  quotaFrom: "headers" | "own";
  auth: "x-goog-api-key" | "bearer";
  // Whether the provider accepts stream_options.include_usage (R4). A provider that rejects it gets false here.
  streamUsage: boolean;
  advanced: boolean;
  keyLabel: string;
  where: { url: string | null; text: string };
};

export const GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_OPENAI_BASE = `${GEMINI_NATIVE_BASE}/openai`;
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
// Owner ruling 07:55: the console's own AI (Ask AI, summary, Playground) defaults to this model.
export const CONSOLE_DEFAULT_MODEL = "gemini-3.8-flash";
// Google models only (owner): Gemini and Antigravity by name, and Cloudflare's Google Gemma models by their full id.
export const GATEWAY_MODEL_PREFIXES: readonly string[] = ["gemini", "antigravity"];
export const CLOUDFLARE_MODEL_PREFIXES: readonly string[] = ["@cf/google/gemma"];

export const PRESETS: Record<PresetKind, Preset> = {
  gemini: {
    name: "Google Gemini",
    baseUrl: () => GEMINI_OPENAI_BASE,
    secretFields: ["apiKey"],
    modelsPath: "/models",
    listModels: "gemini-native",
    quotaFrom: "own",
    auth: "x-goog-api-key",
    streamUsage: true,
    advanced: false,
    keyLabel: "AI Studio API key",
    where: { url: "https://aistudio.google.com/apikey", text: "Create a key (it starts with AQ. or AIza). If Google says the project is restricted or denied, use a key from another Google project or account." },
  },
  cloudflare: {
    name: "Cloudflare Workers AI",
    baseUrl: (s) => `${CLOUDFLARE_API}/accounts/${s.accountId ?? ""}/ai/v1`,
    secretFields: ["accountId", "apiKey"],
    modelsPath: "/models/search",
    listModels: "cloudflare-search",
    quotaFrom: "own",
    auth: "bearer",
    streamUsage: true,
    advanced: false,
    keyLabel: "API token",
    where: { url: "https://dash.cloudflare.com/profile/api-tokens", text: "Create a token with Workers AI: Read. The account ID is on the Workers AI page. Only Google's Gemma models are offered." },
  },
  custom: {
    name: "Custom OpenAI-compatible",
    baseUrl: (s) => (s.baseUrl ?? "").replace(/\/+$/, ""),
    secretFields: ["baseUrl", "apiKey"],
    modelsPath: "/models",
    listModels: "openai",
    quotaFrom: "headers",
    auth: "bearer",
    streamUsage: true,
    advanced: true,
    keyLabel: "API key",
    where: { url: null, text: "Any HTTPS server that speaks the OpenAI chat completions API and answers GET /models. Every model the server lists is offered; switch any off on Models." },
  },
};

export function isPresetKind(k: string): k is PresetKind {
  return (PRESET_KINDS as readonly string[]).includes(k);
}

// No key (a self-host custom provider on the user's own machine, e.g. Ollama or LM Studio): no auth header at all.
export function authHeaders(kind: PresetKind, apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  return PRESETS[kind].auth === "x-goog-api-key" ? { "x-goog-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` };
}

// Last 3 characters only (R3). The prefix tells the owner which kind of key it is, without revealing anything.
// No key: an empty hint (the providers page says so in words).
export function keyHint(apiKey: string): string {
  const k = apiKey.trim();
  if (!k) return "";
  const prefix = k.startsWith("AQ.") ? "AQ." : k.startsWith("AIza") ? "AIza" : "";
  return `${prefix}…${k.slice(-3)}`;
}

export type ConnectForm = { apiKey?: string; accountId?: string; baseUrl?: string; name?: string; makeDefault?: boolean };
export type ValidForm = { secret: ProviderSecret; name: string; baseUrl: string };

const GEMINI_KEY = /^(AIza[0-9A-Za-z_-]{30,60}|AQ\.[0-9A-Za-z._-]{20,400})$/;
const CF_TOKEN = /^[A-Za-z0-9_-]{30,200}$/;
const CF_ACCOUNT = /^[0-9a-f]{32}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

// Slug used in public model ids ("gemini/gemini-3.8-flash"); a custom connection uses its name.
export function providerSlug(kind: PresetKind, name: string): string {
  if (kind !== "custom") return kind;
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";
}

// Cloud (and demo): a local or private host is refused with the reason spelled out (the edition words it).
export const LOCAL_URL = PROVIDERS_COPY.localUrl;
// Self-host (ruling Q11): the user's own machine or network is allowed; these say why an address still isn't.
export const METADATA_URL = "That address is link-local or a cloud metadata service; Watchbell won't call it.";
export const SELFHOST_URL = "Enter an http:// or https:// URL without a query, for example http://localhost:11434/v1.";
export const SELFHOST_BLOCKED = "Watchbell can reach public hosts and your own machine or network (localhost, 10.x, 172.16–31.x, 192.168.x, *.local), not that address.";

// A custom provider's base URL in self-host mode: http or https on any port, no userinfo, query or fragment; a public
// host, loopback or a private LAN address; never link-local or a cloud metadata service. null = fine.
export function selfhostBaseUrlProblem(url: URL): string | null {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return SELFHOST_URL;
  const local = localProviderHost(url.hostname);
  if (local === "metadata") return METADATA_URL;
  if (local) return null;
  return blockedHostname(url.hostname) ? SELFHOST_BLOCKED : null;
}

// `selfhost`: the runtime mode (server side; the form is only validated by the Server Action).
export function validateForm(kind: PresetKind, form: ConnectForm, selfhost: boolean = mode() === "selfhost"): { ok: true; value: ValidForm } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const apiKey = (form.apiKey ?? "").trim();
  const accountId = (form.accountId ?? "").trim().toLowerCase();
  if (kind === "gemini") {
    if (!GEMINI_KEY.test(apiKey)) errors.apiKey = "That doesn't look like a Gemini API key (it starts with AQ. or AIza).";
  } else if (kind === "cloudflare") {
    if (!CF_ACCOUNT.test(accountId)) errors.accountId = "The account ID is 32 hex characters.";
    if (!CF_TOKEN.test(apiKey)) errors.apiKey = "That doesn't look like a Cloudflare API token.";
  } else if (apiKey.length < 8 || apiKey.length > 400 || /\s/.test(apiKey)) {
    errors.apiKey = "That doesn't look like a key.";
  }
  let baseUrl = PRESETS[kind].baseUrl({ apiKey, accountId });
  let name = PRESETS[kind].name;
  if (kind === "custom") {
    name = (form.name ?? "").trim();
    if (!NAME.test(name)) errors.name = "Use 1–40 letters, digits, spaces, dots, dashes or underscores.";
    else if (["gemini", "cloudflare", "groq", "openrouter", "ag", "antigravity"].includes(providerSlug(kind, name))) errors.name = "That name is reserved for a preset. Pick another.";
    const raw = (form.baseUrl ?? "").trim().replace(/\/+$/, "");
    let url: URL | null = null;
    try { url = new URL(raw); } catch { url = null; }
    if (selfhost) {
      const problem = url ? selfhostBaseUrlProblem(url) : SELFHOST_URL;
      if (problem) errors.baseUrl = problem;
      else baseUrl = raw;
      // Follow-up A1: a local server (Ollama, LM Studio) usually has no key. Self-host only, and only for a base URL on
      // the user's own machine or network that passed the checks above; a key that is given is still checked.
      if (!problem && url && apiKey === "" && localProviderHost(url.hostname)) delete errors.apiKey;
    }
    // Cloud and demo: the SSRF rules are unchanged (urlProblem); a local or private host only gets the reason spelled out.
    else if (url && blockedHostname(url.hostname)) errors.baseUrl = LOCAL_URL;
    else if (!url || urlProblem(url) !== null || url.search || url.hash) errors.baseUrl = "Enter a public https:// URL (port 443, no query), for example https://example.com/v1.";
    else baseUrl = raw;
  }
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  const secret: ProviderSecret = kind === "custom" ? { apiKey, baseUrl } : kind === "cloudflare" ? { apiKey, accountId } : { apiKey };
  return { ok: true, value: { secret, name, baseUrl } };
}
