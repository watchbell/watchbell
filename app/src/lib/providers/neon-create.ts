import { z } from "zod";
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";

// Stage 6 create requests (owner 16 Oct): the ONLY Neon create. POST /projects/{id}/branches with `endpoints: []`, so
// no compute starts and no CU-hours are used until someone wakes it (neon.com/docs/manage/branches, API v2). Nothing
// here updates or deletes; the adapter test pins the method, the path and the empty endpoint list. Neon keys have no
// read-only form, so the key that reads the project can create the branch.

const API = "https://console.neon.tech/api/v2";
const NAME = "Neon";

export type NewBranch = { id: string; name: string };

export async function createBranch(token: string, projectId: string, b: { name: string; parentId: string }, opts: FetchOpts = {}): Promise<Result<NewBranch> | { ok: false; kind: "busy"; status: 423; error: string }> {
  const body = { branch: { name: b.name, parent_id: b.parentId }, endpoints: [] as never[] };
  const r = await callJson(NAME, `${API}/projects/${encodeURIComponent(projectId)}/branches`, { method: "POST", token, body }, { timeoutMs: 10_000, ...opts });
  if (!r.ok) {
    if (r.status === 423) return { ok: false, kind: "busy", status: 423, error: "Neon is busy with another operation on this project. Ask again in a minute." };
    if (r.status === 403) return { ...r, kind: "scope", error: "This Neon API key can't manage this project; use a personal or organization key, or a key for this project." };
    if (r.status === 422 || r.status === 400 || r.status === 409) return { ok: false, kind: "format", status: r.status, error: `Neon refused this branch (${r.status}); the project may be at its branch limit.` };
    return r;
  }
  const p = z.object({ branch: z.object({ id: z.string(), name: z.string() }) }).safeParse(r.data);
  return p.success ? { ok: true, data: { id: p.data.branch.id, name: p.data.branch.name } } : formatFailure(NAME, "the new branch");
}
