import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/alias", () => ({ MaskedText: ({ text }: { text: string }) => text }));

import { StatusStrip } from "./status-strip";

const ok = { state: "ok" as const, sub: "fine" };
const empty = { state: "unknown" as const, sub: "No projects watched yet", empty: true };

describe("StatusStrip (1.2.3, UI audit C3)", () => {
  it("leaves out providers with nothing watched, keeps the collector, and sizes the grid to what is left", () => {
    const html = renderToStaticMarkup(h(StatusStrip, { vercel: ok, supabase: empty, neon: empty, firebase: empty, cloudflare: ok, collector: ok }));
    expect(html).toContain("Vercel");
    expect(html).toContain("Cloudflare");
    expect(html).toContain("Collector");
    expect(html).not.toContain("Supabase");
    expect(html).not.toContain("No projects watched yet");
    expect(html).toContain("grid-cols-3");
  });
});
