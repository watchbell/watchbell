// Stage 6 create requests (owner 16 Oct; spec 2026-10-15-stage-6-create-resources.md). The shared, pure contract: the
// table (db/create-schema.ts), the server half (lib/data/create-*.ts), the actions and the dialogs all use these names.
// Owner rule: read-only checks, then exactly one create call per approval; nothing is ever updated or deleted.

export const CREATE_TYPES = ["dns_record", "neon_branch", "supabase_project", "firebase_project"] as const;
export type CreateType = (typeof CREATE_TYPES)[number];
export const CREATE_STATUSES = ["requested", "approved", "running", "done", "failed", "rejected", "expired"] as const;
export type CreateStatus = (typeof CREATE_STATUSES)[number];

export const PROVIDER_OF: Record<CreateType, "cloudflare" | "neon" | "supabase" | "firebase"> = {
  dns_record: "cloudflare", neon_branch: "neon", supabase_project: "supabase", firebase_project: "firebase",
};
export const PROVIDER_NAME: Record<CreateType, string> = {
  dns_record: "Cloudflare", neon_branch: "Neon", supabase_project: "Supabase", firebase_project: "Firebase",
};
export const TYPE_LABEL: Record<CreateType, string> = {
  dns_record: "DNS record", neon_branch: "Neon branch", supabase_project: "Supabase project", firebase_project: "Firebase project",
};
// The page each type lives on: where its waiting list and dialog are, and where Telegram's link points.
export const PAGE_OF: Record<CreateType, string> = {
  dns_record: "/dns", neon_branch: "/neon", supabase_project: "/supabase", firebase_project: "/firebase",
};

export const REQUEST_TTL_MS = 24 * 3_600_000;
export const CREATES_PER_DAY = 3;

// Inputs per type. Never a password, token or key (0049 refuses such keys at the database too).
export type DnsInputs = { zoneName: string; type: "A" | "AAAA" | "CNAME" | "TXT"; name: string; content: string; ttl: number; proxied: boolean };
export type NeonInputs = { projectName: string; parentId: string; parentName: string; name: string };
export type SupabaseInputs = { orgSlug: string; orgName: string; name: string; region: string };
export type FirebaseInputs = { projectId: string; displayName: string };
export type CreateInputs = DnsInputs | NeonInputs | SupabaseInputs | FirebaseInputs;
export type InputsOf<T extends CreateType> = T extends "dns_record" ? DnsInputs : T extends "neon_branch" ? NeonInputs : T extends "supabase_project" ? SupabaseInputs : FirebaseInputs;

// What the create returned: ids and names only.
export type CreateResult = { id?: string; name?: string; note?: string };

// What a page and Overview show. No emails (the requester is "you" or "another member"), no secrets.
export type CreateRequestView = {
  id: string;
  type: CreateType;
  provider: string;
  targetLabel: string;
  summary: string;       // "CNAME shop.example.com → cname.vercel-dns.com"
  confirmName: string;   // what the Owner types to approve (the new resource's name)
  status: CreateStatus;
  mine: boolean;
  result: CreateResult | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
};

export const SECRET_KEYS = ["db_pass", "dbPass", "password", "secret", "token", "apiKey", "api_key", "refresh_token"] as const;

// The approval dialog's sentence (spec §5): the console never deletes.
export const cantRemove = (t: CreateType) => `The console can't remove this later; remove it in ${PROVIDER_NAME[t]}'s dashboard.`;

export function summaryOf(type: CreateType, inputs: CreateInputs): { summary: string; confirmName: string } {
  switch (type) {
    case "dns_record": {
      const i = inputs as DnsInputs;
      return { summary: `${i.type} ${i.name} → ${i.content}${i.proxied ? " (proxied)" : ""}`, confirmName: i.name };
    }
    case "neon_branch": {
      const i = inputs as NeonInputs;
      return { summary: `Branch ${i.name} from ${i.parentName} in ${i.projectName}, no compute`, confirmName: i.name };
    }
    case "supabase_project": {
      const i = inputs as SupabaseInputs;
      return { summary: `Project ${i.name} in ${i.orgName} (${i.region}), free plan`, confirmName: i.name };
    }
    case "firebase_project": {
      const i = inputs as FirebaseInputs;
      return { summary: `Google Cloud project ${i.projectId} ("${i.displayName}") with Firebase, no billing account`, confirmName: i.projectId };
    }
  }
}

// What a create dialog offers, read live when it opens (lib/data/create-options.ts).
export type CreateOptions =
  | { type: "dns_record" }
  | { type: "neon_branch"; branches: { id: string; name: string; isDefault: boolean }[]; limit: number }
  | {
    type: "supabase_project"; accounts: { id: string; label: string }[]; accountId: string | null;
    orgs: { slug: string; name: string; plan: string | null; allowed: boolean }[]; active: number; limit: number; scopeNote: string; error?: string;
  }
  | { type: "firebase_project"; envReady: boolean; connected: boolean; connectedAt: string | null; projects: number | null; quotaHint: number; error?: string };

// The office board's 🙋 Persetujuan list (Stage 9): a waiting create shows as a card that links to the console, where
// the Owner approves with the authenticator code. No names: the office text never carries hosts or ids.
export type CreateBoardItem = { id: string; title: string; url: string; createdAt: string; expiresAt: string };
export function boardItem(v: Pick<CreateRequestView, "id" | "type" | "createdAt" | "expiresAt">): CreateBoardItem {
  return { id: v.id, title: `Create ${TYPE_LABEL[v.type]} on ${PROVIDER_NAME[v.type]}`, url: `${PAGE_OF[v.type]}?create=${encodeURIComponent(v.id)}`, createdAt: v.createdAt, expiresAt: v.expiresAt };
}
