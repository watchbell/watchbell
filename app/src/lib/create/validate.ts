import { NEON_FREE } from "@/lib/databases/neon";
import { FREE_SLOTS, usesSlot } from "@/lib/databases/supabase";
import { AUTO_TTL, EDITABLE, validateEdit } from "@/lib/network/dns-edit";
import type { DnsRecord } from "@/lib/network/rules";
import type { DnsInputs, FirebaseInputs, NeonInputs, SupabaseInputs } from "./types";

// Stage 6 create requests: the pure checks. The dialog and the server use the same functions; the server runs them on
// the request and again (with a fresh live read) right before the one create call.

export type Invalid = { ok: false; field: string; error: string };
export type Valid<T> = { ok: true; inputs: T } | Invalid;
// A live free-tier check: ok with the cost sentence the approval shows, or the number that blocks it.
export type Check = { ok: true; cost: string } | { ok: false; error: string };

const str = (v: unknown, max = 300) => (typeof v === "string" && v.length <= max ? v : "");
const bad = (field: string, error: string): Invalid => ({ ok: false, field, error });

// ---------- Cloudflare DNS record ----------
const LABEL = /^(?:\*|[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;

// "shop", "shop.example.com", "@" or "example.com." → the full name inside the zone, or null.
export function fullName(raw: string, zone: string): string | null {
  const z = zone.trim().toLowerCase().replace(/\.$/, "");
  let n = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!n || !z) return null;
  if (n === "@") n = z;
  else if (n !== z && !n.endsWith(`.${z}`)) n = `${n}.${z}`;
  if (n.length > 253) return null;
  const sub = n === z ? "" : n.slice(0, -(z.length + 1));
  if (sub && !sub.split(".").every((l, i) => LABEL.test(l) && (l !== "*" || i === 0))) return null;
  return n;
}

export function validateDns(raw: unknown, zoneName: string): Valid<DnsInputs> {
  const x = (raw ?? {}) as Record<string, unknown>;
  const type = str(x.type, 10);
  if (!(EDITABLE as readonly string[]).includes(type)) return bad("type", "Only A, AAAA, CNAME and TXT records can be added here.");
  const name = fullName(str(x.name, 260), zoneName);
  if (!name) return bad("name", `The name must be a host in ${zoneName}, like shop or shop.${zoneName}.`);
  const ttl = typeof x.ttl === "number" ? x.ttl : AUTO_TTL;
  const v = validateEdit({ type, name }, { content: str(x.content, 4096), ttl, proxied: x.proxied === true });
  if (!v.ok) return bad(v.field, v.error);
  return { ok: true, inputs: { zoneName: zoneName.toLowerCase(), type: type as DnsInputs["type"], name, content: v.values.content, ttl: v.values.ttl, proxied: v.values.proxied } };
}

// The live record list, read right before: the name must be free (spec §3). A CNAME can never share its name, and any
// other type is refused too when the name is taken, so the console only ever adds a brand-new name.
export function dnsCheck(records: Pick<DnsRecord, "name" | "type">[], i: Pick<DnsInputs, "name" | "type">, truncated = false): Check {
  if (truncated) return { ok: false, error: "This zone has more than 2,000 records, so the console can't be sure the name is free. Add it in Cloudflare." };
  const same = records.filter((r) => r.name.toLowerCase().replace(/\.$/, "") === i.name);
  if (same.some((r) => r.type === "CNAME")) return { ok: false, error: `${i.name} already has a CNAME record, and a CNAME can't share its name with any other record.` };
  if (i.type === "CNAME" && same.length) return { ok: false, error: `${i.name} already has ${same.length} record${same.length === 1 ? "" : "s"}; a CNAME can't share its name with other records.` };
  if (same.length) return { ok: false, error: `${i.name} already exists in this zone. The console only adds new names; edit the existing record instead.` };
  return { ok: true, cost: "Free. Cloudflare's free plan allows thousands of records per zone." };
}

// ---------- Neon branch ----------
export const NEON_BRANCH = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NEON_BRANCH_ID = /^br-[a-z0-9-]{3,60}$/;

export function validateNeon(raw: unknown, projectName: string): Valid<Omit<NeonInputs, "parentName">> {
  const x = (raw ?? {}) as Record<string, unknown>;
  const name = str(x.name, 80).trim();
  if (!NEON_BRANCH.test(name)) return bad("name", "Use 1 to 63 lower-case letters, digits and hyphens, starting with a letter or digit.");
  const parentId = str(x.parentId, 80);
  if (!NEON_BRANCH_ID.test(parentId)) return bad("parentId", "Pick the branch to copy from.");
  return { ok: true, inputs: { projectName, parentId, name } };
}

export function neonCheck(branches: { id: string; name: string }[], i: Pick<NeonInputs, "name" | "parentId">): Check {
  if (!branches.some((b) => b.id === i.parentId)) return { ok: false, error: "The branch to copy from isn't in this project any more. Reload and pick another." };
  if (branches.some((b) => b.name === i.name)) return { ok: false, error: `A branch named ${i.name} already exists in this project.` };
  if (branches.length >= NEON_FREE.branches) {
    return { ok: false, error: `This project already has ${branches.length} branches, Neon's free limit is ${NEON_FREE.branches}.` };
  }
  return {
    ok: true,
    cost: `Free. Uses ${branches.length + 1} of ${NEON_FREE.branches} branches in this project. No compute is created, so it uses no CU-hours until someone wakes it; its data counts toward the project's 0.5 GB storage.`,
  };
}

// ---------- Supabase project ----------
// The region codes POST /v1/projects accepts as region_selection {type: "specific"} (api.supabase.com/api/v1-json,
// checked 16 Oct 2026).
export const SUPABASE_REGIONS = [
  ["ap-southeast-1", "Southeast Asia (Singapore)"], ["ap-northeast-1", "Northeast Asia (Tokyo)"], ["ap-northeast-2", "Northeast Asia (Seoul)"],
  ["ap-southeast-2", "Oceania (Sydney)"], ["ap-south-1", "South Asia (Mumbai)"], ["ap-east-1", "East Asia (Hong Kong)"],
  ["us-east-1", "East US (North Virginia)"], ["us-east-2", "East US (Ohio)"], ["us-west-1", "West US (North California)"], ["us-west-2", "West US (Oregon)"],
  ["ca-central-1", "Canada (Central)"], ["sa-east-1", "South America (São Paulo)"],
  ["eu-west-1", "West EU (Ireland)"], ["eu-west-2", "West EU (London)"], ["eu-west-3", "West EU (Paris)"], ["eu-north-1", "North EU (Stockholm)"],
  ["eu-central-1", "Central EU (Frankfurt)"], ["eu-central-2", "Central EU (Zurich)"],
] as const;
const REGION_CODES: readonly string[] = SUPABASE_REGIONS.map(([c]) => c);
const SUPA_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const ORG_SLUG = /^[\w-]{1,64}$/;

export function validateSupabase(raw: unknown): Valid<Omit<SupabaseInputs, "orgName">> {
  const x = (raw ?? {}) as Record<string, unknown>;
  const orgSlug = str(x.orgSlug, 80);
  if (!ORG_SLUG.test(orgSlug)) return bad("orgSlug", "Pick an organization.");
  const name = str(x.name, 80).trim();
  if (!SUPA_NAME.test(name)) return bad("name", "Use 1 to 63 letters, digits, spaces, dots, hyphens or underscores.");
  const region = str(x.region, 30);
  if (!REGION_CODES.includes(region)) return bad("region", "Pick a region from the list.");
  return { ok: true, inputs: { orgSlug, name, region } };
}

// Spec §5: a paid organization or an unknown plan is refused (stricter than restore). The free plan allows FREE_SLOTS
// active projects per user across the free organizations; every project in an org whose plan isn't "paid for sure"
// counts, so an unreadable plan can only make the check stricter.
export type SupabaseFacts = {
  plan: string | null;                                         // the target org's plan, read live
  projects: { name: string; status: string; orgSlug: string }[]; // every project the token can see, live
  paidOrgs: ReadonlySet<string>;                                // orgs whose plan read as paid
};


export function supabaseCheck(f: SupabaseFacts, i: Pick<SupabaseInputs, "orgSlug" | "name">): Check {
  if (f.plan === null) return { ok: false, error: "The console couldn't read this organization's plan, so it won't create anything there. Only an organization on the free plan is allowed." };
  if (f.plan !== "free") return { ok: false, error: `This organization is on the ${f.plan} plan. The console only creates projects in an organization on the free plan, because a project in a paid organization is billed from the first hour.` };
  if (f.projects.some((p) => p.orgSlug === i.orgSlug && p.name.toLowerCase() === i.name.toLowerCase() && p.status !== "REMOVED")) {
    return { ok: false, error: `This organization already has a project named ${i.name}.` };
  }
  const active = f.projects.filter((p) => !f.paidOrgs.has(p.orgSlug) && usesSlot(p.status)).length;
  if (active >= FREE_SLOTS) {
    return { ok: false, error: `${active} free projects are already active, Supabase's free limit is ${FREE_SLOTS}. Pause one first; paused projects don't count.` };
  }
  return { ok: true, cost: `Free. Uses ${active + 1} of ${FREE_SLOTS} active free projects. Free projects pause after a week without activity.` };
}

// ---------- Firebase project ----------
// Google Cloud project ids: 6–30 characters, lower-case letters, digits and hyphens, starting with a letter and not
// ending with a hyphen. Display names: 4–30 characters (letters, digits, spaces, quotes, hyphens, exclamation marks).
const GCP_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_NAME = /^[A-Za-z0-9 '"!-]{4,30}$/;
// Google's default project quota for an account without a billing account is small and not readable by API (Firebase
// FAQ: "usually around 5–10"; deleted projects keep counting for 30 days). The console warns from here on.
export const GCP_QUOTA_HINT = 10;

export function validateFirebase(raw: unknown): Valid<FirebaseInputs> {
  const x = (raw ?? {}) as Record<string, unknown>;
  const projectId = str(x.projectId, 40).trim();
  if (!GCP_ID.test(projectId) || /google|ssl|undefined|null/.test(projectId)) {
    return bad("projectId", "6 to 30 lower-case letters, digits and hyphens, starting with a letter (Google refuses ids with \"google\").");
  }
  const displayName = str(x.displayName, 40).trim() || projectId.slice(0, 30);
  if (!GCP_NAME.test(displayName)) return bad("displayName", "4 to 30 letters, digits, spaces, hyphens, quotes or exclamation marks.");
  return { ok: true, inputs: { projectId, displayName } };
}

export function firebaseCheck(projects: { projectId: string; state: string }[], i: Pick<FirebaseInputs, "projectId">): Check {
  if (projects.some((p) => p.projectId === i.projectId)) return { ok: false, error: `You already have a Google Cloud project with the id ${i.projectId}.` };
  const active = projects.filter((p) => p.state === "ACTIVE").length;
  if (active >= GCP_QUOTA_HINT) {
    return { ok: false, error: `This Google account already has ${active} active projects. Google's project quota without a billing account is about ${GCP_QUOTA_HINT}; remove one in the Google Cloud console first (deleted projects count for 30 days).` };
  }
  return {
    ok: true,
    cost: `Free (Spark): no billing account is attached. ${active} active Google Cloud project${active === 1 ? "" : "s"} now; Google's quota without billing is about ${GCP_QUOTA_HINT}, and Google may refuse earlier.`,
  };
}
