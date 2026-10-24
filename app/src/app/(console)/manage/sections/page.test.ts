import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SectionState } from "@/lib/data/sections-db";

const s = vi.hoisted(() => ({
  role: "owner" as "owner" | "operator" | "viewer",
  state: null as unknown as SectionState,
}));
vi.mock("@/lib/auth", () => ({ pageGate: async (min: string) => ({ ok: s.role === min, member: { id: "m", userId: "u", role: s.role } }) }));
vi.mock("@/lib/data/sections-db", () => ({ sectionState: async () => s.state, monitorCounts: async () => ({ http: 12, heartbeat: 3 }) }));
vi.mock("./actions", () => ({ setSectionOn: vi.fn() }));

import SectionsPage from "./page";

const render = async () => renderToStaticMarkup(h("div", null, await SectionsPage()));
// The switch input of a section, as rendered.
const input = (html: string, label: string) => new RegExp(`<input[^>]*aria-label="${label} section"[^>]*/>`).exec(html)?.[0] ?? "";

beforeEach(() => {
  s.role = "owner";
  // DevOps off by hand (GitHub connected); Database not connected yet; Hosting on.
  s.state = { on: ["home", "hosting", "manage"], available: ["home", "hosting", "devops", "manage"], off: ["devops"], providers: ["github"], has: { databases: false } };
});

describe("Manage › Sections page", () => {
  it("is the owner's alone", async () => {
    for (const role of ["operator", "viewer"] as const) {
      s.role = role;
      const html = await render();
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain("Hosting");
    }
  });

  it("lists every section with a line of what it holds; Home and Manage are always on", async () => {
    const html = await render();
    for (const label of ["Home", "Hosting", "Database", "DevOps", "Manage"]) expect(html).toContain(`<b class="font-medium">${label}</b>`);
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html.match(/Always on<\/span>/g)).toHaveLength(2);
    expect(html).toContain("Applications, Deployments, Domains, DNS records, Uptime and Logs.");
  });

  // Review A1, Important 1: each switch shows the section's real state, the same as the menu.
  it("shows the real state: on when shown, off when turned off, off and disabled when nothing is connected yet", async () => {
    const html = await render();
    expect(input(html, "Hosting")).toContain('checked=""');
    expect(input(html, "Hosting")).not.toContain("disabled");
    expect(input(html, "DevOps")).not.toContain("checked");
    expect(input(html, "DevOps")).not.toContain("disabled");
    expect(html).toContain("Off: hidden from the menu; its sync, alerts and auto-actions are paused. Its data is kept.");
    expect(input(html, "Database")).not.toContain("checked");
    expect(input(html, "Database")).toContain('disabled=""');
    expect(html).toContain('Appears when you connect Supabase, Neon, Firebase, Turso or Upstash in <a href="/connections">Connections</a>.');
  });

  it("matches the switch to what the menu shows, for every section", async () => {
    const html = await render();
    for (const [id, label] of [["hosting", "Hosting"], ["database", "Database"], ["devops", "DevOps"]] as const) {
      expect(input(html, label).includes("checked")).toBe(s.state.on.includes(id));
    }
  });

  it("says Keep active and Auto-restore keep running while Database is off", async () => {
    s.state = { ...s.state, available: [...s.state.available, "database"], off: ["database"] };
    const html = await render();
    expect(html).toContain("Keep active and Auto-restore keep running while it is off");
  });
});
