import "server-only";
import { loadTarget } from "@/lib/data/provider-action-db";
import { isUuid } from "@/lib/ids";
import type { Failure, Result } from "@/lib/providers/http";
import { AUTO_PERMISSIONS, type AutoAccess, autoAccess, poolerConfig, runProjectSql } from "@/lib/providers/supabase-sql";
import { RO_ROLE } from "@/lib/sql/role-sql";
import { pgErrorText } from "@/lib/sql/run";
import { generatePassword, type PoolerConfig, poolerDsn, rollbackScript, scramVerifier, setupScript } from "@/lib/sql/supabase-auto";
import { dbAlias } from "@/lib/view/display-name";
import { aliasBook } from "./cached";
import { type SaveDone, saveSqlConnection, watched } from "./sql-db";

// Stage 9 slice 2b: "Set up automatically (read-only)" for a watched Supabase project (the owner's server action in
// app/(console)/sql/actions.ts checks the role, the quota and the id first). Order: the pooler host (nothing changes
// if it can't be built) → one idempotent setup script through the Management API → the normal save-time read-only
// check on the new string → sealed save. A failed check revokes what the setup granted and turns login off; nothing is
// dropped. The password lives only in this call's memory and in the sealed string: never returned, logged or audited.

export type AutoTarget = { ref: string; token: string; paused: boolean };
export type AutoAudit = { kind: "ok" | "err"; message: string; resourceId: string };
export type AutoDone = { ok: true; message: string; audit: AutoAudit } | { ok: false; error: string; audit?: AutoAudit };

export type AutoDeps = {
  target: (resourceId: string) => Promise<AutoTarget | null>;
  pooler: (token: string, ref: string) => Promise<Result<PoolerConfig[]>>;
  run: (token: string, ref: string, query: string, readOnly: boolean) => Promise<Result<unknown>>;
  access: (token: string, ref: string) => Promise<AutoAccess>;
  save: (resourceId: string, dsn: string, actorUserId: string) => Promise<SaveDone>;
  alias: (resourceId: string) => Promise<string>;
  password: () => string;
  verifier: (password: string) => string;
  sleep: (ms: number) => Promise<void>;
};

async function supabaseTarget(resourceId: string): Promise<AutoTarget | null> {
  const w = await watched(resourceId);
  if (!w || w.provider !== "supabase") return null;
  const t = await loadTarget(resourceId, "supabase_project");
  if (!t || t.resource.externalId !== w.externalId) return null;
  return { ref: w.externalId, token: t.token, paused: w.state === "paused" };
}

export const autoDefaults: AutoDeps = {
  target: supabaseTarget,
  pooler: (token, ref) => poolerConfig(token, ref),
  run: (token, ref, query, readOnly) => runProjectSql(token, ref, query, readOnly),
  access: (token, ref) => autoAccess(token, ref),
  save: (resourceId, dsn, actorUserId) => saveSqlConnection(resourceId, dsn, false, actorUserId),
  alias: async (id) => dbAlias(await aliasBook(), id),
  password: () => generatePassword(),
  verifier: (p) => scramVerifier(p),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const GONE = "That Supabase project is no longer watched, or its token can't be read.";
const PAUSED = "This project is paused. Restore it first, then add SQL access.";
export const SAVE_ATTEMPTS = 3;
export const RETRY_MS = 2_000;

// The pooler can take a moment to see a new or changed password: these failures are tried again, a few seconds apart.
const RETRYABLE = new Set([{ code: "28P01" }, { code: "08006" }, { code: "CONNECT_TIMEOUT" }].map(pgErrorText));

export const permissionText = (missing: string[]) =>
  `This project's token can't set the role up (missing ${missing.join(", ")}). It needs ${AUTO_PERMISSIONS}; replace the token on Connections, or create the role by hand below.`;

function apiError(r: Failure): string {
  if (r.kind === "scope") return permissionText(r.missing ?? ["database_write"]);
  return r.error;
}

// For the dialog: can this project's token run the setup? Only read-only calls (see autoAccess).
export async function sqlAutoStatus(resourceId: string, deps: AutoDeps = autoDefaults): Promise<AutoAccess> {
  if (!isUuid(resourceId)) return { can: false, reason: "other", error: "Something in that request wasn't valid." };
  const t = await deps.target(resourceId);
  if (!t) return { can: false, reason: "other", error: GONE };
  if (t.paused) return { can: false, reason: "other", error: PAUSED };
  return deps.access(t.token, t.ref);
}

export async function createSqlAccessAuto(resourceId: string, actorUserId: string, deps: AutoDeps = autoDefaults): Promise<AutoDone> {
  if (!isUuid(resourceId)) return { ok: false, error: "Something in that request wasn't valid." };
  const t = await deps.target(resourceId);
  if (!t) return { ok: false, error: GONE };
  if (t.paused) return { ok: false, error: PAUSED };

  // 1. The connection string first: if it can't be built, nothing in the database changes.
  const pooler = await deps.pooler(t.token, t.ref);
  if (!pooler.ok) return { ok: false, error: apiError(pooler) };
  const password = deps.password();
  const built = poolerDsn(pooler.data, t.ref, password);
  if (!built.ok) return { ok: false, error: built.error };

  const alias = await deps.alias(resourceId);
  const failAudit: AutoAudit = { kind: "err", message: `SQL access automatic setup failed · ${alias}`, resourceId };
  const rollback = async (): Promise<boolean> => (await deps.run(t.token, t.ref, rollbackScript(), false)).ok;

  // 2. The setup script (one DO block: all or nothing).
  const setup = await deps.run(t.token, t.ref, setupScript(deps.verifier(password)), false);
  if (!setup.ok) {
    // No answer at all: the script may still have run, so take its grants back.
    if (setup.kind === "transient" && setup.status === undefined) {
      const undone = await rollback();
      return { ok: false, error: `${setup.error} ${undone ? "Any grants it may have given were revoked." : `Check the ${RO_ROLE} role in the Supabase SQL Editor.`}`, audit: failAudit };
    }
    return { ok: false, error: apiError(setup), audit: failAudit };
  }

  // 3. The existing save-time check (BEGIN READ ONLY holds, CREATE TEMP TABLE fails, no write privilege), then the
  // sealed save. Only a sign-in or connect failure is tried again.
  let saved: SaveDone = { ok: false, error: "Not checked." };
  for (let i = 0; i < SAVE_ATTEMPTS; i++) {
    if (i > 0) await deps.sleep(RETRY_MS);
    saved = await deps.save(resourceId, built.dsn, actorUserId);
    if (saved.ok || !RETRYABLE.has(saved.error)) break;
  }
  if (!saved.ok) {
    const undone = await rollback();
    return {
      ok: false,
      error: `The new role didn't pass the read-only check, so nothing was saved: ${saved.error} ${undone
        ? `Its grants were revoked and its login turned off (the role ${RO_ROLE} stays; nothing was dropped).`
        : `Revoking its grants failed too: run "revoke all on all tables in schema public from ${RO_ROLE}; alter role ${RO_ROLE} nologin;" in the Supabase SQL Editor.`}`,
      audit: failAudit,
    };
  }
  return {
    ok: true,
    message: `SQL access created for ${alias}: read-only role ${RO_ROLE} checked and saved.`,
    audit: { kind: "ok", message: `SQL access created automatically for ${alias} (read-only role ${RO_ROLE})`, resourceId },
  };
}
