import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extension } from "@/lib/extensions";

// The repository page and the runner's preview (registry r1's RepoPreviewSlot, private edition): without the slot the
// page has no preview card at all; with it, the card is there for owners, on repositories still shared.
const ext = vi.hoisted(() => ({ extensions: { nav: [], palette: [] } as Extension }));
const m = vi.hoisted(() => ({ role: "owner", goneAt: null as Date | null }));
vi.mock("@/lib/extensions", () => ext);
vi.mock("@/lib/auth", () => ({ requirePageMember: async () => ({ id: "m", userId: "u", role: m.role }) }));
vi.mock("@/lib/data/repos-db", () => ({
  repoHead: async () => ({
    repo: { id: REPO, name: "acme-shop", fullName: "o/acme-shop", htmlUrl: null, private: true, archived: false, defaultBranch: "main", pushedAt: null, goneAt: m.goneAt, actions: null, actionsCheckedAt: null },
    apps: [], ref: "main",
  }),
  repoInfoOf: async () => ({ ok: false, error: "offline" }),
  readmeOf: vi.fn(), treeOf: vi.fn(), fileOf: vi.fn(), commitsOf: vi.fn(), branchesOf: vi.fn(), runsOf: vi.fn(), repoDepsView: vi.fn(),
}));

const REPO = "33333333-3333-4333-8333-333333333333";
import RepoPage from "./page";

// Every element in the returned tree (function components are not called: their own output isn't needed here).
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...elements(children)];
}
const page = async () => elements(await RepoPage({ params: Promise.resolve({ id: REPO }), searchParams: Promise.resolve({}) }));
const Slot: (p: { repoId: string }) => null = () => null;

beforeEach(() => {
  ext.extensions = { nav: [], palette: [] };
  m.role = "owner";
  m.goneAt = null;
});

describe("repository page and the preview slot", () => {
  it("renders without a preview card when no extension registers one (open source edition)", async () => {
    const tree = await page();
    expect(tree.length).toBeGreaterThan(10);
    expect(tree.some((e) => typeof e.type === "function" && /preview/i.test((e.type as { name?: string }).name ?? ""))).toBe(false);
  });

  it("renders the registered slot with the repository id, for owners only, never on a repository no longer shared", async () => {
    ext.extensions = { nav: [], palette: [], RepoPreviewSlot: Slot };
    expect((await page()).filter((e) => e.type === Slot).map((e) => e.props)).toEqual([{ repoId: REPO }]);
    m.role = "operator";
    expect((await page()).some((e) => e.type === Slot)).toBe(false);
    m.role = "owner";
    m.goneAt = new Date("2026-10-01T00:00:00Z");
    expect((await page()).some((e) => e.type === Slot)).toBe(false);
  });
});
