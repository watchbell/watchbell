import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { openOrNull } from "@/lib/crypto";
import { firestoreFailure } from "@/lib/databases/firebase";
import { serverEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { buildStructuredQuery, type FsQuery, type FsRun, listRootCollections, runFirestoreQuery } from "@/lib/providers/firestore-query";
import { googleAccessToken, parseServiceAccount } from "@/lib/providers/google";
import type { Failure } from "@/lib/providers/http";
import { dbAlias, hideEmails } from "@/lib/view/display-name";
import { aliasBook } from "./cached";
import type { RunAudit } from "./sql-db";

// Stage 9 slice 2: the Firestore query builder's server side. It reuses the Firebase account's service account (sealed
// in ops.accounts) to get a 1-hour token, then makes one read-only REST call. The credential never leaves this file.

const CALL_MS = 8_000;

export type FsDeps = {
  key: () => string;
  token: typeof googleAccessToken;
  list: typeof listRootCollections;
  run: typeof runFirestoreQuery;
  alias: (id: string) => Promise<string>;
  clock: () => number;
};
export const fsDefaults: FsDeps = {
  key: () => serverEnv().OPS_ENCRYPTION_KEY, token: googleAccessToken, list: listRootCollections, run: runFirestoreQuery,
  alias: async (id) => dbAlias(await aliasBook(), id), clock: () => performance.now(),
};

type Access = { ok: true; projectId: string; token: string } | { ok: false; error: string };

// Google's words, without an email (a service account's address can appear in a permission error).
function failureText(f: Failure): string {
  const named = firestoreFailure({ kind: f.kind, reason: f.reason ?? null });
  if (named.state === "err") return named.label;
  return hideEmails(f.message ?? f.error).slice(0, 400);
}

async function access(resourceId: string, deps: FsDeps): Promise<Access> {
  const [r] = await db().select({ projectId: resources.externalId, ciphertext: accounts.credentialCiphertext, iv: accounts.credentialIv })
    .from(resources).innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(and(eq(resources.id, resourceId), eq(resources.kind, "firestore"), eq(resources.monitored, true), isNull(resources.goneAt)))
    .limit(1);
  if (!r) return { ok: false, error: "That Firestore project is no longer watched." };
  const plain = openOrNull({ ciphertext: r.ciphertext, iv: r.iv }, deps.key());
  const sa = plain ? parseServiceAccount(plain) : null;
  if (!sa) return { ok: false, error: "The Firebase account's credential can't be read. Replace it in Connections." };
  const t = await deps.token(sa, { timeoutMs: CALL_MS });
  if (!t.ok) return { ok: false, error: t.error };
  return { ok: true, projectId: r.projectId, token: t.data };
}

export async function firestoreCollections(resourceId: string, deps: FsDeps = fsDefaults): Promise<{ ok: true; ids: string[]; more: boolean } | { ok: false; error: string }> {
  if (!isUuid(resourceId)) return { ok: false, error: "Something in that request wasn't valid." };
  const a = await access(resourceId, deps);
  if (!a.ok) return a;
  const r = await deps.list(a.token, a.projectId, { timeoutMs: CALL_MS });
  return r.ok ? { ok: true, ...r.data } : { ok: false, error: failureText(r) };
}

// The query's shape (collection, fields, operators, order, limit), hashed; the values typed into it are left out.
export function fsFingerprint(q: FsQuery): string {
  const shape = JSON.stringify([q.collection, q.where.map((w) => [w.field, w.op, w.type]), q.orderBy, q.limit]);
  return createHash("sha256").update(shape).digest("hex").slice(0, 12);
}

export type FsDone =
  | { ok: true; result: FsRun & { durationMs: number }; audit: RunAudit }
  | { ok: false; error: string; audit?: RunAudit };

// One query. The audit says which database, how many documents (= reads) and a fingerprint of the query's shape; the
// collection, the fields and the values stay out of it.
export async function queryFirestore(resourceId: string, input: unknown, admit: () => Promise<string | null>, deps: FsDeps = fsDefaults): Promise<FsDone> {
  if (!isUuid(resourceId)) return { ok: false, error: "Something in that request wasn't valid." };
  const built = buildStructuredQuery(input);
  if (!built.ok) return built;
  const refused = await admit();
  if (refused) return { ok: false, error: refused };
  const a = await access(resourceId, deps);
  if (!a.ok) return a;
  const started = deps.clock();
  const r = await deps.run(a.token, a.projectId, built.body, { timeoutMs: CALL_MS });
  const durationMs = Math.round(deps.clock() - started);
  const alias = await deps.alias(resourceId);
  const fp = fsFingerprint(built.query);
  if (!r.ok) {
    return { ok: false, error: failureText(r), audit: { kind: "err", resourceId, message: `Firestore query failed · ${alias} · ${durationMs} ms`, detail: `fingerprint ${fp}` } };
  }
  const n = r.data.docs.length;
  return {
    ok: true, result: { ...r.data, durationMs },
    audit: { kind: "ok", resourceId, message: `Firestore query · ${alias} · ${n} doc${n === 1 ? "" : "s"} · ${r.data.reads} read${r.data.reads === 1 ? "" : "s"} · ${durationMs} ms`, detail: `fingerprint ${fp}` },
  };
}
