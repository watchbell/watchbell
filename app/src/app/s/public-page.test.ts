import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicView } from "@/lib/data/public-status-db";

const publicView = vi.fn<(slug: string, now: Date) => Promise<PublicView | null>>();
vi.mock("@/lib/data/public-status-db", () => ({ publicView: (slug: string, now: Date) => publicView(slug, now) }));

import PublicStatusPage from "./[slug]/page";
import StatusPageNotFound from "./[slug]/not-found";

const bars = [{ tone: "ok" as const, title: "1 Oct: 100%" }];
const row = (name: string, state: PublicView["monitors"][number]["state"], label: string) =>
  ({ name, badge: name.toLowerCase(), state, label, uptime: "99.9%", bars });
const page = (monitors: PublicView["monitors"]): PublicView => ({ title: "Acme status", announcement: null, maintenance: [], monitors });
const render = async (slug = "acme") => renderToStaticMarkup(await PublicStatusPage({ params: Promise.resolve({ slug }) }));

beforeEach(() => publicView.mockReset());

// 1.2.1 (UI audit P1, P3, P6): what a visitor sees on /s/<slug>.
describe("the public status page", () => {
  it("answers in one line, above the rows, whether everything is running", async () => {
    publicView.mockResolvedValue(page([row("Shop", "ok", "Operational"), row("Blog", "ok", "Operational")]));
    const html = await render();
    expect(html).toContain("All 2 services are running.");
    expect(html.indexOf("All 2 services are running.")).toBeLessThan(html.indexOf(">Shop<"));
  });

  it("names the service that is down", async () => {
    publicView.mockResolvedValue(page([row("Shop", "err", "Down"), row("Blog", "ok", "Operational")]));
    expect(await render()).toContain("Shop is down.");
  });

  it("has no summary line on an empty page", async () => {
    publicView.mockResolvedValue(page([]));
    expect(await render()).not.toContain("running.");
  });

  it("shows visitors no README badge (an owner tool; it lives in Settings › Status page)", async () => {
    publicView.mockResolvedValue(page([row("Shop", "ok", "Operational")]));
    const html = await render();
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/badge/i);
  });

  it("an unknown slug is a 404", async () => {
    publicView.mockResolvedValue(null);
    await expect(render("nope")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
});

describe("the status page 404", () => {
  it("is plain and friendly, with no way into the console", () => {
    const html = renderToStaticMarkup(h(StatusPageNotFound));
    expect(html).toContain("No status page here");
    expect(html).toContain("Check the link with whoever sent it.");
    expect(html).not.toMatch(/href=/);
    expect(html).not.toMatch(/sign in|console|<script/i);
  });
});
