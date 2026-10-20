import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Stage 6 create requests (owner 16 Oct): a new Firebase project, the official way (the Firebase CLI's projects:create
// does the same): 1) Cloud Resource Manager v3 projects.create (POST /v3/projects), a Google Cloud project with NO
// billing account, so it stays on the free Spark plan; 2) Firebase Management v1beta1 projects.addFirebase (POST
// /v1beta1/projects/{id}:addFirebase), which "does not modify any billing account information". Both are long-running
// operations, polled with GETs. Discovery docs checked 16 Oct 2026: projects.create needs the cloud-platform scope;
// addFirebase accepts cloud-platform or firebase and needs firebase.projects.update, resourcemanager.projects.get,
// serviceusage.services.enable and serviceusage.services.get (Owner/Editor of the new project, which its creator is).
//
// The credential is the Owner's own OAuth grant (scope cloud-platform), never the viewer-only service accounts. Nothing
// here updates, enables billing on, or deletes a project; the adapter test pins the two POSTs.

const CRM = "https://cloudresourcemanager.googleapis.com/v3";
const FB = "https://firebase.googleapis.com/v1beta1";
const MAX_PAGES = 5;
const OP_NAME = /^operations\/(?!.*\.\.)[A-Za-z0-9._:/-]{1,200}$/; // no "..": the name goes into a URL path

export type GcpProject = { projectId: string; displayName: string; state: string };
export type Operation = { name: string; done: boolean; error: string | null };

const projectSchema = z.object({ projectId: z.string(), displayName: z.string().optional(), state: z.string().default("ACTIVE") });

// Every project the Owner can see (read), for the quota count and the "id already yours" check.
export async function listGcpProjects(token: string, opts: FetchOpts = {}): Promise<Result<GcpProject[]>> {
  const out: GcpProject[] = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const r = await callJson("Google Cloud", `${CRM}/projects:search?${q}`, { token }, opts);
    if (!r.ok) return r;
    const p = z.object({ projects: z.array(projectSchema).optional(), nextPageToken: z.string().optional() }).safeParse(r.data);
    if (!p.success) return formatFailure("Google Cloud", "the project list");
    out.push(...(p.data.projects ?? []).map((x) => ({ projectId: x.projectId, displayName: x.displayName ?? x.projectId, state: x.state })));
    if (!p.data.nextPageToken) break;
    pageToken = p.data.nextPageToken;
  }
  return { ok: true, data: out };
}

const opSchema = z.object({ name: z.string(), done: z.boolean().optional(), error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional() });
const toOp = (data: unknown, name: string): Result<Operation> => {
  const p = opSchema.safeParse(data);
  if (!p.success || !OP_NAME.test(p.data.name)) return formatFailure(name, "the operation");
  // Only the code: Google's message could name the account.
  return { ok: true, data: { name: p.data.name, done: p.data.done === true, error: p.data.error ? `error ${p.data.error.code ?? "?"}` : null } };
};

// Write 1 of 2: the Google Cloud project, created without a parent organization or billing account.
export async function createGcpProject(token: string, p: { projectId: string; displayName: string }, opts: FetchOpts = {}): Promise<Result<Operation>> {
  const r = await callJson("Google Cloud", `${CRM}/projects`, { method: "POST", token, body: { projectId: p.projectId, displayName: p.displayName } }, { timeoutMs: 15_000, ...opts });
  return r.ok ? toOp(r.data, "Google Cloud") : r;
}

// Write 2 of 2: Firebase on that project.
export async function addFirebase(token: string, projectId: string, opts: FetchOpts = {}): Promise<Result<Operation>> {
  const r = await callJson("Firebase", `${FB}/projects/${encodeURIComponent(projectId)}:addFirebase`, { method: "POST", token, body: {} }, { timeoutMs: 15_000, ...opts });
  return r.ok ? toOp(r.data, "Firebase") : r;
}

// Reads: a long-running operation of either API.
export async function getOperation(token: string, api: "crm" | "firebase", name: string, opts: FetchOpts = {}): Promise<Result<Operation>> {
  if (!OP_NAME.test(name)) return formatFailure(api === "crm" ? "Google Cloud" : "Firebase", "the operation name");
  const label = api === "crm" ? "Google Cloud" : "Firebase";
  const r = await callJson(label, `${api === "crm" ? CRM : FB}/${name}`, { token }, opts);
  return r.ok ? toOp(r.data, label) : r;
}
