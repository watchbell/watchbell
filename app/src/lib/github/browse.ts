import { type HiddenReason, hiddenReason } from "@/lib/code/never-read";

// GitHub → Repositories (owner 16 Oct: "just show the projects", clickable, leading to the project). Read-only. Pure:
// the list's filters and sort, the linked apps per repository, the file tree and what the file view may show.

export type LinkedApp = { id: string; name: string };

// One row of the list, plain data (it goes to the client component).
export type RepoListItem = {
  id: string; fullName: string; private: boolean; archived: boolean; defaultBranch: string | null; pushedAt: string | null;
  language: string | null; apps: LinkedApp[]; advisories: number | null; actions: { state: string; label: string } | null;
};

export type RepoFilter = { q: string; linked: "" | "linked" | "unlinked"; visibility: "" | "private" | "public" };
export const NO_FILTER: RepoFilter = { q: "", linked: "", visibility: "" };

const pushed = (r: Pick<RepoListItem, "pushedAt">) => (r.pushedAt ? Date.parse(r.pushedAt) || 0 : 0);

// Name (or a linked app's name, or the language) contains the text; linked/unlinked; private/public. Newest push first,
// never-pushed last, then by name.
export function filterRepos<T extends RepoListItem>(rows: T[], f: RepoFilter): T[] {
  const q = f.q.trim().toLowerCase();
  return rows
    .filter((r) => !f.linked || (f.linked === "linked") === r.apps.length > 0)
    .filter((r) => !f.visibility || (f.visibility === "private") === r.private)
    .filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.apps.some((a) => a.name.toLowerCase().includes(q)) || (r.language ?? "").toLowerCase() === q)
    .sort((a, b) => pushed(b) - pushed(a) || a.fullName.localeCompare(b.fullName));
}

// repoId → its linked apps (an app links to one repository; a repository may serve several apps), by name. Links to an
// app that is gone or unknown are dropped.
export function linkedAppsByRepo(links: { appId: string; repoId: string }[], apps: LinkedApp[]): Map<string, LinkedApp[]> {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const out = new Map<string, LinkedApp[]>();
  for (const l of links) {
    const app = byId.get(l.appId);
    if (!app) continue;
    const list = out.get(l.repoId) ?? [];
    if (!list.some((a) => a.id === app.id)) list.push(app);
    out.set(l.repoId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- the file tree ----
export type TreeNode = {
  name: string; path: string; kind: "dir" | "file"; size: number; hidden: HiddenReason | null; children: TreeNode[];
};

export const TREE_SHOW_MAX = 3000; // files drawn in the tree; a bigger repository is cut (with a note)

// The tree of a repository's blobs (git tree paths): folders first, then files, each by name (case-insensitive). A
// folder that is never read whole (node_modules/, .next/, secrets/) keeps no children, so its files are never listed.
export function buildTree(entries: { path: string; size: number }[], max = TREE_SHOW_MAX): { root: TreeNode; files: number; cut: boolean } {
  const root: TreeNode = { name: "", path: "", kind: "dir", size: 0, hidden: null, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);
  let files = 0;
  let cut = false;
  const dirOf = (path: string): TreeNode | null => {
    const known = dirs.get(path);
    if (known) return known;
    const at = path.lastIndexOf("/");
    const parent = dirOf(at < 0 ? "" : path.slice(0, at));
    if (!parent || parent.hidden) return null;
    const reason = hiddenReason(`${path}/x`);
    const node: TreeNode = { name: path.slice(at + 1), path, kind: "dir", size: 0, hidden: reason === "binary" ? null : reason, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (!e.path || e.path.startsWith("/") || e.path.split("/").some((s) => !s || s === "." || s === "..")) continue;
    const at = e.path.lastIndexOf("/");
    const parent = dirOf(at < 0 ? "" : e.path.slice(0, at));
    if (!parent || parent.hidden) continue;
    if (files >= max) {
      cut = true;
      continue;
    }
    parent.children.push({ name: e.path.slice(at + 1), path: e.path, kind: "file", size: e.size, hidden: hiddenReason(e.path), children: [] });
    files++;
  }
  const order = (n: TreeNode) => {
    n.children.sort((a, b) => (a.kind === b.kind ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    n.children.forEach(order);
  };
  order(root);
  return { root, files, cut };
}

// The folders above a path ("a/b/c.ts" → ["a", "a/b"]): the tree opens them so the file in view is visible.
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export const FILE_VIEW_MAX = 200 * 1024;

export type FilePlan =
  | { kind: "read"; size: number }
  | { kind: "hidden"; reason: HiddenReason }
  | { kind: "too-big"; size: number }
  | { kind: "missing" };

// What the file view does with a requested path: only a path that is in the tree is read (no arbitrary paths), never a
// file that matches the never-read rule, never one over FILE_VIEW_MAX.
export function filePlan(path: string, entries: { path: string; size: number }[]): FilePlan {
  const hidden = hiddenReason(path);
  if (hidden === "secret") return { kind: "hidden", reason: hidden };
  const entry = entries.find((e) => e.path === path);
  if (!entry) return { kind: "missing" };
  if (hidden) return { kind: "hidden", reason: hidden };
  if (entry.size > FILE_VIEW_MAX) return { kind: "too-big", size: entry.size };
  return { kind: "read", size: entry.size };
}

// "1.2 KB", "340 B", "2.1 MB".
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// GitHub's next-page link: the open count of a list read with per_page=1 is the last page's number.
export function countFromLink(link: string | null, pageLength: number): number {
  const m = link ? /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link) : null;
  return m ? Number(m[1]) : pageLength;
}
