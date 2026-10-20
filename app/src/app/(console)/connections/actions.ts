"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { credentialProblem, statusAfterTest, validateAccountLabel } from "@/lib/accounts";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { updateTags } from "@/lib/cache/invalidate";
import { ALL_TAGS } from "@/lib/cache/tags";
import { openOrNull, seal } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { tokenStatus } from "@/lib/providers/cloudflare";
import { githubUser } from "@/lib/providers/github";
import { type Provider, PROVIDER_INFO, PROVIDERS } from "@/lib/providers/info";
import { normalizeCredential } from "@/lib/providers/normalize";
import { type TestResult, testConnection } from "@/lib/providers/test-connection";
import { tokenExpiry } from "@/lib/providers/vercel";

const deps = { requireActionMember };
const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

// Vercel, Cloudflare and GitHub tell us when a token expires, which drives the "Expires" column (and stage 5's 14-day warning).
async function expiryFor(provider: Provider, credential: string): Promise<{ expiresAt?: Date | null }> {
  if (provider === "vercel") {
    const r = await tokenExpiry(credential);
    return r.ok ? { expiresAt: r.data } : {};
  }
  if (provider === "cloudflare") {
    const r = await tokenStatus(credential);
    return r.ok ? { expiresAt: r.data.expiresAt } : {};
  }
  if (provider === "github" || provider === "github_write") {
    const r = await githubUser(credential);
    return r.ok ? { expiresAt: r.data.expiresAt } : {};
  }
  return {};
}

async function cleanAndTest(provider: Provider, raw: string): Promise<{ value: string; test: TestResult } | { error: string }> {
  const clean = normalizeCredential(provider, raw);
  if (!clean.ok) return { error: clean.error };
  return { value: clean.value, test: await testConnection(provider, clean.value) };
}

export async function checkCredential(provider: string, credential: string): Promise<ActionResult<TestResult>> {
  return runGuarded("owner", async (member): Promise<ActionResult<TestResult>> => {
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many connection tests. Try again in ${minutesText(quota.retryAfter)}.` };
    if (!isProvider(provider)) return { ok: false, error: "Unknown provider." };
    const r = await cleanAndTest(provider, credential);
    if ("error" in r) return { ok: false, error: r.error, fieldErrors: { credential: r.error } };
    return { ok: true, data: r.test };
  }, deps);
}

export async function addAccount(provider: string, label: string, credential: string): Promise<ActionResult<TestResult>> {
  return runGuarded("owner", async (member): Promise<ActionResult<TestResult>> => {
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many connection tests. Try again in ${minutesText(quota.retryAfter)}.` };
    if (!isProvider(provider)) return { ok: false, error: "Unknown provider." };
    const existing = await db().select({ label: accounts.label }).from(accounts).where(eq(accounts.provider, provider));
    const v = validateAccountLabel(provider, label, { labels: existing.map((e) => e.label), count: existing.length });
    if (!v.ok) return { ok: false, error: v.error, fieldErrors: { label: v.error } };
    const r = await cleanAndTest(provider, credential);
    if ("error" in r) return { ok: false, error: r.error, fieldErrors: { credential: r.error } };
    if (!r.test.ok) return { ok: false, error: r.test.error, data: r.test };
    const sealed = seal(r.value, serverEnv().OPS_ENCRYPTION_KEY);
    await db().insert(accounts).values({
      provider,
      label: v.label,
      credentialCiphertext: sealed.ciphertext,
      credentialIv: sealed.iv,
      keyVersion: sealed.keyVersion,
      credentialKind: PROVIDER_INFO[provider].credentialKind,
      scopeNote: (r.test.ok && r.test.scopeNote) || PROVIDER_INFO[provider].accessNote,
      status: "ok",
      lastTestAt: new Date(),
      ...(await expiryFor(provider, r.value)),
    });
    revalidatePath("/connections");
    revalidatePath("/welcome");
    return { ok: true, message: `${PROVIDER_INFO[provider].name} · ${v.label} connected.`, data: r.test };
  }, deps);
}

export async function replaceCredential(accountId: string, credential: string): Promise<ActionResult<TestResult>> {
  return runGuarded("owner", async (member): Promise<ActionResult<TestResult>> => {
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many connection tests. Try again in ${minutesText(quota.retryAfter)}.` };
    const [account] = await db().select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account || !isProvider(account.provider)) return { ok: false, error: "That account no longer exists." };
    const r = await cleanAndTest(account.provider, credential);
    if ("error" in r) return { ok: false, error: r.error, fieldErrors: { credential: r.error } };
    if (!r.test.ok) return { ok: false, error: r.test.error, data: r.test };
    const sealed = seal(r.value, serverEnv().OPS_ENCRYPTION_KEY);
    await db().update(accounts).set({
      credentialCiphertext: sealed.ciphertext, credentialIv: sealed.iv, keyVersion: sealed.keyVersion,
      status: "ok", lastError: null, lastTestAt: new Date(), updatedAt: new Date(),
      ...(r.test.ok && r.test.scopeNote ? { scopeNote: r.test.scopeNote } : {}),
      ...(await expiryFor(account.provider, r.value)),
    }).where(eq(accounts.id, accountId));
    revalidatePath("/connections");
    return { ok: true, message: `${PROVIDER_INFO[account.provider].name} · ${account.label} is connected again.`, data: r.test };
  }, deps);
}

export async function retestAccount(accountId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const quota = await limit(LIMITS.credential, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many connection tests. Try again in ${minutesText(quota.retryAfter)}.` };
    const [account] = await db().select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account || !isProvider(account.provider)) return { ok: false, error: "That account no longer exists." };
    const plain = openOrNull({ ciphertext: account.credentialCiphertext, iv: account.credentialIv }, serverEnv().OPS_ENCRYPTION_KEY);
    const problem = credentialProblem(plain);
    const test: TestResult = problem ? { ok: false, kind: "auth", error: problem } : await testConnection(account.provider, plain!);
    // A timeout or provider outage doesn't mean the credential is bad, so only a rejection flips the status.
    // Otherwise nothing is written: the last test time keeps pointing at a test that actually decided something.
    const change = statusAfterTest(test);
    if (change) {
      await db().update(accounts).set({
        ...change, lastTestAt: new Date(), updatedAt: new Date(),
        ...(test.ok && test.scopeNote ? { scopeNote: test.scopeNote } : {}),
        ...(test.ok ? await expiryFor(account.provider, plain!) : {}),
      }).where(eq(accounts.id, accountId));
    }
    revalidatePath("/connections");
    return test.ok ? { ok: true, message: `${PROVIDER_INFO[account.provider].name} · ${account.label}: ${test.summary}.` } : { ok: false, error: test.error };
  }, deps);
}

export async function removeAccount(accountId: string): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    const deleted = await db().delete(accounts).where(eq(accounts.id, accountId)).returning({ provider: accounts.provider, label: accounts.label });
    revalidatePath("/connections");
    // Its resources go with it (cascade): every cached list may have shown one (perf P3).
    if (deleted.length) updateTags(ALL_TAGS);
    const gone = deleted[0];
    if (!gone) return { ok: false, error: "That account no longer exists." };
    const name = isProvider(gone.provider) ? PROVIDER_INFO[gone.provider].name : gone.provider === "drive" ? "Google Drive" : gone.provider;
    return { ok: true, message: `${name} · ${gone.label} removed. Its credential is deleted.` };
  }, deps);
}
