"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { storeRecord } from "@/lib/data/dns-edit-db";
import { finish, loadTarget, targetQuota } from "@/lib/data/provider-action-db";
import { isUuid } from "@/lib/ids";
import { auditText, canEdit, canProxy, type Change, planEdit, type RecordValues, sameRecord } from "@/lib/network/dns-edit";
import type { DnsRecord } from "@/lib/network/rules";
import { type ActionOutcome, INVALID, scopeMessage, STALE, type WriteFailure } from "@/lib/provider-actions";
import { type CfWriteFailure, getDnsRecord, updateDnsRecord } from "@/lib/providers/cloudflare";

// Stage 6 slice 2 (plan B1–B8): the Owner's Cloudflare DNS edits: switch a record between proxied and DNS only, or change
// its content and TTL. Only A, AAAA, CNAME and TXT; type and name never change; nothing is ever created or deleted.
// Like every action: role (Owner, spec §12) → arguments → quota → zone and credential → live read → the dialog's record
// must still be Cloudflare's (stale guard) → one PATCH → audit → access → snapshot and cache.

const deps = { requireActionMember };
const RECORD_ID = /^[0-9a-f]{32}$/;
const CONTENT_MAX = 4096; // generous: the rules (TXT ≤ 2048) give the real limit and the real sentence
const GONE = "This zone isn't watched any more, or its Cloudflare credential can't be read. Reload the page.";
const MISSING = "Cloudflare can't find this record any more. It leaves this page after the next hourly read.";
const TYPES = "Only A, AAAA, CNAME and TXT records can be edited here.";

const refuse = (message: string): ActionOutcome => ({ done: false, message });

function values(v: unknown): RecordValues | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  if (typeof x.content !== "string" || x.content.length > CONTENT_MAX) return null;
  if (typeof x.ttl !== "number" || !Number.isFinite(x.ttl) || typeof x.proxied !== "boolean") return null;
  return { content: x.content, ttl: x.ttl, proxied: x.proxied };
}

// The snapshot and the cached pages follow the record Cloudflare has. The write already happened (or nothing was
// written), so a failure here is logged and the next hourly read catches up.
async function remember(zoneResourceId: string, record: DnsRecord): Promise<void> {
  try {
    await storeRecord(zoneResourceId, record);
  } catch {
    console.warn("dns snapshot update failed");
  }
}

function doneMessage(r: DnsRecord, changes: Change[]): string {
  if (changes.length === 1 && changes[0].field === "proxied") {
    return changes[0].after === "DNS only" ? `${r.name} is DNS only now. Cloudflare applies it within a minute.` : `${r.name} is proxied through Cloudflare now.`;
  }
  return `Saved ${r.type} ${r.name}. Cloudflare applies it within a minute; resolvers may keep the old value until its TTL runs out.`;
}

function failure(r: CfWriteFailure): WriteFailure {
  if (r.kind === "scope") return { ok: false, kind: "scope", status: r.status, error: scopeMessage("cloudflare", {}) };
  if (r.kind === "missing") return { ok: false, kind: "missing", status: 404, error: MISSING };
  return { ok: false, kind: r.kind, error: r.error, ...(r.status ? { status: r.status } : {}) };
}

// `before` is the record as the dialog showed it, `after` the values the Owner wants.
export async function editDnsRecordAction(zoneResourceId: string, recordId: string, before: RecordValues, after: RecordValues): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const shown = values(before);
    const wanted = values(after);
    if (!isUuid(zoneResourceId) || typeof recordId !== "string" || !RECORD_ID.test(recordId) || !shown || !wanted) return { ok: false, error: INVALID };
    const quota = await targetQuota(member.id, "dns", recordId);
    if (quota) return { ok: false, error: quota };
    const t = await loadTarget(zoneResourceId, "zone");
    if (!t || !t.resource.externalId) return { ok: false, error: GONE };
    const zoneId = t.resource.externalId;
    const done = (o: ActionOutcome) => finish(o, member, t.account.id);

    const live = await getDnsRecord(t.token, zoneId, recordId);
    if (!live.ok) return done(refuse(live.kind === "scope" ? scopeMessage("cloudflare", {}) : live.kind === "missing" ? MISSING : live.error));
    const rec = live.data;
    if (!canEdit(rec.type)) return done(refuse(TYPES));
    if (!sameRecord(rec, shown)) {
      await remember(zoneResourceId, rec);
      return done(refuse(STALE));
    }
    const plan = planEdit(rec, wanted);
    if (!plan.ok) return done(refuse(plan.error));

    const body = { type: rec.type, name: rec.name, content: plan.values.content, ttl: plan.values.ttl, ...(canProxy(rec.type) ? { proxied: plan.values.proxied } : {}) };
    const r = await updateDnsRecord(t.token, zoneId, recordId, body);
    const text = auditText(rec, plan.changes);
    if (!r.ok) {
      return done({ done: false, failed: failure(r), audit: { message: `DNS edit failed · ${rec.type} ${rec.name}`, resourceId: zoneResourceId } });
    }
    await remember(zoneResourceId, r.data);
    return done({ done: true, message: doneMessage(rec, plan.changes), audit: { message: text.message, resourceId: zoneResourceId, detail: text.detail } });
  }, deps);
}
