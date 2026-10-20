"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { AuthError, type ActionResult, runGuarded } from "@/lib/action";
import { getSessionUser, requireActionMember } from "@/lib/auth";
import { OAUTH_TTL_S, sealTicket } from "@/lib/backup/connect";
import { DRIVE_ENV_MISSING, driveEnv, newState, pkcePair } from "@/lib/backup/google-oauth";
import { approveCreate, type FlowDeps, rejectCreate, requestCreate } from "@/lib/create/flow";
import { CREATE_COOKIE, CREATE_COOKIE_PATH, createAuthUrl, createRedirectUri } from "@/lib/create/google-connect";
import type { CreateResult, CreateType } from "@/lib/create/types";
import { recordAction } from "@/lib/data/audit-db";
import { claimRequest, decideRequest, finishRequest, getRequest, insertRequest, removeCreateGrant } from "@/lib/data/create-db";
import { EXECUTORS } from "@/lib/data/create-exec";
import { notifyCreateRequest } from "@/lib/data/create-notify";
import { createOptions, type CreateOptions } from "@/lib/data/create-options";
import { serverEnv } from "@/lib/env";
import { limit } from "@/lib/rate-limit-db";
import { LIMITS } from "@/lib/rate-limit";
import { cooldownText } from "@/lib/provider-actions";
import type { Role } from "@/lib/roles";

// Stage 6 create requests (spec 2026-10-15 §4–5, owner 16 Oct). Asking is Owner-only (the spec's default: Operators
// can't ask until the owner allows it). Approving and rejecting need the Owner with an aal2 session, checked here on top
// of runGuarded. Telegram can only point here: approval buttons there are not allowed for creates.

const REQUEST_ROLE: Role = "owner";

// Owner + aal2, said explicitly (requireActionMember already sends an owner without aal2 to the MFA step).
async function requireOwnerAal2() {
  const member = await requireActionMember("owner");
  const session = await getSessionUser();
  if (session?.aal !== "aal2") throw new AuthError("mfa");
  return member;
}

const deps: FlowDeps = {
  now: () => new Date(),
  quota: async (memberId) => {
    const q = await limit(LIMITS.providerAction, memberId);
    return q.allowed ? null : cooldownText("member", q.retryAfter);
  },
  limitRequest: async (memberId) => (await limit(LIMITS.createRequest, memberId)).allowed,
  executor: (t) => EXECUTORS[t](),
  insert: (row) => insertRequest(row),
  get: getRequest,
  decide: decideRequest,
  claim: claimRequest,
  finish: finishRequest,
  audit: recordAction,
  notify: (row) => notifyCreateRequest(row),
};

const reRender = () => {
  try {
    refresh();
  } catch {
    // outside a server action render: nothing to refresh
  }
};

export async function requestCreateAction(type: CreateType, target: string, inputs: unknown): Promise<ActionResult<{ id: string; cost: string }>> {
  return runGuarded(REQUEST_ROLE, async (member) => {
    const r = await requestCreate({ id: member.id, userId: member.userId }, type, target, inputs, deps);
    if (r.ok) reRender();
    return r;
  }, { requireActionMember });
}

// `typed`: the new resource's name, typed by the Owner (as GitHub does for destructive actions). The result's
// `secret` (a Supabase database password) is shown once in the dialog and is never stored.
export async function approveCreateAction(id: string, typed: string): Promise<ActionResult<{ secret?: string; result?: CreateResult }>> {
  return runGuarded("owner", async (member) => {
    const r = await approveCreate({ id: member.id, userId: member.userId }, id, typed, deps);
    reRender();
    return r;
  }, { requireActionMember: requireOwnerAal2 });
}

export async function rejectCreateAction(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const r = await rejectCreate({ id: member.id, userId: member.userId }, id, deps);
    reRender();
    return r;
  }, { requireActionMember: requireOwnerAal2 });
}

// The dialog's live choices (reads only): a Neon project's branches, the Supabase organizations with their plans, the
// Firebase grant and project count.
export async function createOptionsAction(type: CreateType, target: string): Promise<ActionResult<CreateOptions>> {
  return runGuarded(REQUEST_ROLE, async (member) => {
    const q = await deps.quota(member.id, `options:${type}`);
    if (q) return { ok: false, error: q };
    return createOptions(type, target);
  }, { requireActionMember });
}

// Firebase: start the Owner's "Connect Google (create projects)" (cloud-platform scope), separate from Drive.
export async function startGoogleCreateConnect(): Promise<ActionResult<{ url: string }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ url: string }>> => {
    const env = driveEnv();
    if (!env) return { ok: false, error: DRIVE_ENV_MISSING };
    const { SITE_URL, OPS_ENCRYPTION_KEY } = serverEnv();
    const state = newState();
    const { verifier, challenge } = pkcePair();
    (await cookies()).set(CREATE_COOKIE, sealTicket({ state, verifier, memberId: member.id, exp: Date.now() + OAUTH_TTL_S * 1000 }, OPS_ENCRYPTION_KEY), {
      httpOnly: true, secure: SITE_URL.startsWith("https://"), sameSite: "lax", path: CREATE_COOKIE_PATH, maxAge: OAUTH_TTL_S,
    });
    return { ok: true, data: { url: createAuthUrl(env, { state, challenge, redirectUri: createRedirectUri(SITE_URL) }) } };
  }, { requireActionMember: requireOwnerAal2 });
}

export async function disconnectGoogleCreate(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    await removeCreateGrant();
    await recordAction({ kind: "ok", message: "Google (create projects) disconnected", resourceId: null, actorUserId: member.userId }).catch(() => undefined);
    reRender();
    return { ok: true, message: "Disconnected here. Remove Watchbell's access in your Google Account → Security → Third-party access as well." };
  }, { requireActionMember });
}
