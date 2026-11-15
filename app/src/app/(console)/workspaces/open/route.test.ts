import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), listWorkspaces: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/workspace-db", () => ({ listWorkspaces: h.listWorkspaces }));

import { GET } from "./route";

const K = "00000000-0000-4000-8000-0000000000b1";
const get = (q: string) => GET(new Request(`https://ops.example.com/workspaces/open${q}`));

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue({ id: "m", userId: "u", email: "v@example.com", role: "viewer" });
  h.listWorkspaces.mockResolvedValue([{ id: K, name: "Kopi Senja", position: 0 }]);
});

// Watchbell 1.8: the palette's "Go to workspace" link sets the cookie and opens Overview.
describe("GET /workspaces/open", () => {
  it("sets the workspace cookie and goes to Overview", async () => {
    const res = await get(`?id=${K}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://ops.example.com/");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^wb_ws=${K};.*Path=/.*HttpOnly.*SameSite=lax`, "i"));
  });

  it("refuses an unknown workspace and a signed-out visitor", async () => {
    expect((await get("?id=nope")).status).toBe(404);
    h.requireActionMember.mockRejectedValue(new AuthError("signed-out"));
    expect((await get(`?id=${K}`)).headers.get("location")).toBe("https://ops.example.com/signin");
  });
});
