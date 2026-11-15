import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./metrics-key-dialog", () => ({ MetricsKeyButtons: () => null }));

import type { ComputePanel } from "@/lib/view/usage";
import { ComputeCard } from "./compute-panel";

const gauge = (label: string) => ({ label, value: "10%", pct: 10, series: [], peak: null });
const ok = (o: Partial<Extract<ComputePanel, { kind: "ok" }>> = {}): ComputePanel => ({
  kind: "ok", gauges: ["CPU", "RAM", "Disk", "Connections"].map(gauge), asOf: "2 min ago", stale: false, error: null, memory: null, commit: null, ...o,
});
const render = (panel: ComputePanel) => renderToStaticMarkup(h(ComputeCard, { blocks: [{ id: "db1", name: "db-i", alias: "db-i", ref: "abcdefghijklmnopqrst", paused: false, panel }], owner: false }));

describe("ComputeCard memory and commitment (owner 13 Nov)", () => {
  it("shows RAM now and 24 hourly stacks of used, cache + buffers and swap against total RAM", () => {
    const out = render(ok({ memory: {
      now: { total: "1.80 GB", used: "400 MB", cache: "300 MB", swap: "200 MB" }, parts: ["Used", "Cache + Buffers", "Swap"], max: 100,
      bars: Array.from({ length: 24 }, (_, i) => ({ key: String(i), title: `h${i}`, values: [40, 30, 20] })),
    } }));
    expect(out).toContain("Memory");
    expect(out).toContain("400 MB used");
    expect(out).toContain("300 MB cache + buffers");
    expect(out).toContain("200 MB swap");
    expect(out).toContain("of 1.80 GB");
    expect(out).toContain("Cache + Buffers");
  });
  it("shows the commitment of its limit and says Warning when it is high", () => {
    const out = render(ok({ commit: { value: "1.25 GB of 1.40 GB", pct: 89.3, tone: "warn", series: [], peak: "90% peak 24 h", note: null } }));
    expect(out).toContain("Memory commitment");
    expect(out).toContain("1.25 GB of 1.40 GB");
    expect(out).toContain("Warning");
    expect(out).not.toContain("Memory commitment</span><span>Warning");
    expect(render(ok({ commit: { value: "0.50 GB of 1.40 GB", pct: 35.7, series: [], peak: null, note: null } }))).not.toContain("Warning");
  });
  it("says why memory is critical and what helps (1.7.1)", () => {
    const note = "Swap is 349 MB of 408 MB RAM: queries slow down. Use the pooler (port 6543).";
    const out = render(ok({ commit: { value: "1.46 GB of 1.20 GB", pct: 122, tone: "err", series: [], peak: null, note } }));
    expect(out).toContain("Critical");
    expect(out).toContain(note);
  });
  it("says when it updates: with each collector run, not every 5 minutes", () => {
    expect(render(ok())).toContain("Metrics API · each collector run");
    expect(render(ok())).not.toContain("Memory commitment");
  });
});
