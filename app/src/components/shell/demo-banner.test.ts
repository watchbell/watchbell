import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/overview", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { DEMO_COLLECTOR_TEXT } from "@/lib/collector/status";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { CollectorStatus } from "./collector-status";
import { DEMO_BANNER_RESET_TEXT, DEMO_BANNER_TEXT } from "./demo-banner";
import { Shell } from "./shell";

const shell = (demo: boolean) => renderToStaticMarkup(h(Shell, {
  user: { email: "visitor@example.com", role: "owner" }, collector: { lastRunAt: null, now: 0, demo }, alerts: 0, book: EMPTY_BOOK, shot: false,
  children: h("p", null, "page"),
}));

describe("demo banner and collector status", () => {
  it("every console page shows the slim demo banner in demo, and only there", () => {
    expect(DEMO_BANNER_TEXT).toBe("Demo — data is made up and resets.");
    expect(DEMO_BANNER_RESET_TEXT).toBe("Results of your actions can disappear when the demo restarts.");
    expect(shell(true)).toContain(`${DEMO_BANNER_TEXT} ${DEMO_BANNER_RESET_TEXT}`);
    expect(shell(false)).not.toContain(DEMO_BANNER_TEXT);
    expect(shell(false)).not.toContain(DEMO_BANNER_RESET_TEXT);
  });

  it("the sidebar footer says the demo has no live collector instead of turning late and stopped", () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    expect(renderToStaticMarkup(h(CollectorStatus, { initialLastRunAt: old, initialNow: Date.now(), demo: true }))).toContain(DEMO_COLLECTOR_TEXT);
    expect(renderToStaticMarkup(h(CollectorStatus, { initialLastRunAt: old, initialNow: Date.now() }))).toContain("Collector stopped");
  });
});
