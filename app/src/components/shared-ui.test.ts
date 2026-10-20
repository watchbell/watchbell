import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sparkline, UptimeBars } from "@/components/charts";
import { NoApps, NoDeployments, NoEvents, NoMonitors } from "@/components/empty-states";
import { LaterButton, Tag } from "@/components/kit";
import { ListFilter } from "@/components/list-filter";
import { holdCount, holdRefresh, holdWhile } from "@/components/live";
import { Pager } from "@/components/pager";
import { PlainTable } from "@/components/plain-table";
import type { Bar } from "@/lib/view/uptime";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("Sparkline", () => {
  it("draws the area at 12% and a 1.5 px line, accent by default", () => {
    const out = html(h(Sparkline, { values: [1, 3, 2], width: 100, height: 20, label: "p95" }));
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="p95"');
    expect(out).toContain('opacity="0.12"');
    expect(out).toContain('stroke-width="1.5"');
    expect(out).toContain("text-brand");
    expect(out).toContain('width="100"');
    expect(out).not.toContain("preserveAspectRatio");
  });
  it("uses the err tone and stretches when fluid", () => {
    const out = html(h(Sparkline, { values: [1, 2], width: 100, height: 20, tone: "err", fluid: true, label: "x" }));
    expect(out).toContain("text-err");
    expect(out).toContain('width="100%"');
    expect(out).toContain('viewBox="0 0 100 20"');
    expect(out).toContain('preserveAspectRatio="none"');
  });
  it("draws no paths without numbers", () => {
    const out = html(h(Sparkline, { values: [null, null], width: 100, height: 20, label: "x" }));
    expect(out).not.toContain("<path");
  });
  it("adds a dashed second line (p50, A6) and deploy ticks with tooltips (A1), each with a legend entry", () => {
    const out = html(h(Sparkline, {
      values: [10, 30, 20], second: [5, 15, 10], ticks: [{ x: 50, title: "Deployed c8202c1 · 21:30" }], width: 100, height: 20, label: "x",
    }));
    expect(out).toContain('stroke-dasharray="4 3"');
    expect(out).toContain("<title>Deployed c8202c1 · 21:30</title>");
    expect(out).toContain('x1="50"');
    expect(out).toContain("p95");
    expect(out).toContain("p50");
    expect(out).toContain("Production deploy");
  });
  it("has no legend when it only draws one line", () => {
    const out = html(h(Sparkline, { values: [1, 2], width: 100, height: 20, label: "x" }));
    expect(out).not.toContain("p95");
    expect(out).not.toContain("stroke-dasharray");
  });
});

describe("UptimeBars", () => {
  const bars: Bar[] = [
    { day: "2026-10-10", tone: "none", title: "a" },
    { day: "2026-10-11", tone: "ok", title: "b" },
    { day: "2026-10-12", tone: "err", title: "c" },
  ];
  it("renders one titled bar per day with a summary", () => {
    const out = html(h(UptimeBars, { bars }));
    expect(out.match(/<span /g)).toHaveLength(3);
    expect(out).toContain('title="b"');
    expect(out).toContain("bg-line-strong");
    expect(out).toContain("bg-ok");
    expect(out).toContain("bg-err");
    expect(out.match(/opacity-85/g)).toHaveLength(3);
    expect(out).toContain("Last 3 days: 1 without failures, 0 with 1 or 2 failed checks, 1 with 3 or more, 1 without data");
  });
  it("draws a maintenance-only day in faint brand blue and counts it (U5)", () => {
    const out = html(h(UptimeBars, { bars: [...bars, { day: "2026-10-13", tone: "maint", title: "d" }] }));
    expect(out).toContain("bg-brand opacity-45");
    expect(out.match(/opacity-85/g)).toHaveLength(3);
    expect(out).toContain("1 with only maintenance");
  });
  it("puts a dark notch on a day with a production deploy and counts them (A1)", () => {
    const out = html(h(UptimeBars, { bars: [{ ...bars[1], deploy: "c8202c1" }, bars[2]] }));
    expect(out.match(/inset_0_3px_0/g)).toHaveLength(1);
    expect(out).toContain("1 with a production deploy");
  });
});

describe("PlainTable", () => {
  it("renders the head and each row", () => {
    const out = html(h(PlainTable, {
      head: ["Name", "State"],
      rows: [{ key: "a", state: "ok", text: "alpha", row: h("tr", null, h("td", null, "alpha")) }],
    }));
    expect(out).toContain("<th");
    expect(out).toContain("Name");
    expect(out).toContain("<td>alpha</td>");
  });
});

const nRows = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `r${i}`, state: "ok", text: `row ${i}`, row: h("tr", null, h("td", null, `row ${i}`)) }));

describe("PlainTable paging", () => {
  it("shows no pager when everything fits on one page", () => {
    const out = html(h(PlainTable, { head: ["Name"], rows: nRows(25) }));
    expect(out).not.toContain("Next page");
    expect(out).not.toContain(" of 25");
  });
  it("shows the first 25 rows with the range and a disabled Previous", () => {
    const out = html(h(PlainTable, { head: ["Name"], rows: nRows(30) }));
    expect(out).toContain("1–25 of 30");
    expect(out).toContain("row 24<");
    expect(out).not.toContain("row 25<");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous page"|<button[^>]*aria-label="Previous page"[^>]*disabled=""/);
    expect(out).not.toMatch(/<button[^>]*aria-label="Next page"[^>]*disabled/);
  });
});

describe("ListFilter paging", () => {
  it("counts the filtered total in the toolbar and the page range in the pager", () => {
    const out = html(h(ListFilter, { placeholder: "Filter", head: ["Name"], rows: nRows(104) }));
    expect(out).toContain("104 items");
    expect(out).toContain("1–25 of 104");
    expect(out).toContain('role="status"');
  });
  it("has no pager for a short list", () => {
    const out = html(h(ListFilter, { placeholder: "Filter", head: ["Name"], rows: nRows(3) }));
    expect(out).not.toContain("Previous page");
  });
});

describe("Pager", () => {
  const noop = () => {};
  it("renders nothing for one page", () => {
    expect(html(h(Pager, { page: 1, pages: 1, text: "1–3 of 3", onPage: noop }))).toBe("");
  });
  it("bleeds out of a padded card body only when asked", () => {
    expect(html(h(Pager, { page: 1, pages: 2, text: "1–25 of 30", onPage: noop, bleed: true }))).toContain("-mx-[18px]");
    expect(html(h(Pager, { page: 1, pages: 2, text: "1–25 of 30", onPage: noop }))).not.toContain("-mx-[18px]");
  });
  it("disables Next on the last page and labels both buttons", () => {
    const out = html(h(Pager, { page: 3, pages: 3, text: "51–60 of 60", onPage: noop }));
    expect(out).toContain('aria-label="Previous page"');
    expect(out).toContain('aria-label="Next page"');
    expect(out).toContain("51–60 of 60");
    expect(out).not.toMatch(/<button[^>]*aria-label="Previous page"[^>]*disabled/);
    expect(out).toMatch(/<button[^>]*aria-label="Next page"[^>]*disabled/);
  });
});

describe("empty states and kit additions", () => {
  it("offers Connections only to an owner", () => {
    expect(html(h(NoApps, { owner: true }))).toContain('href="/connections"');
    const member = html(h(NoApps, { owner: false }));
    expect(member).not.toContain("href=");
    expect(member).toContain("An owner picks the apps to watch in Connections.");
  });
  it("says what is missing", () => {
    expect(html(h(NoDeployments))).toContain("No deployments in the last 30 days");
    expect(html(h(NoMonitors))).toContain("No monitors yet");
    expect(html(h(NoDeployments))).not.toContain("within a minute");
    expect(html(h(NoEvents))).toContain("No events yet");
  });
  it("Tag renders the label chip", () => {
    expect(html(h(Tag, null, "Production"))).toContain("Production");
  });
  it("LaterButton is disabled and names its stage in the tooltip", () => {
    const out = html(h(LaterButton, { label: "Redeploy", stage: 3 }));
    expect(out).toContain('title="Arrives in stage 3"');
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-label="Redeploy, arrives in stage 3"');
    expect(out).toContain("Redeploy");
  });
});

describe("NoMonitors", () => {
  it("mentions Add monitor only to someone who can use it", () => {
    expect(html(h(NoMonitors))).not.toContain("Add monitor");
    expect(html(h(NoMonitors, { canAct: false }))).not.toContain("Add monitor");
    expect(html(h(NoMonitors, { canAct: true }))).toContain("Add more with Add monitor.");
  });
});

describe("ListFilter", () => {
  const head = ["Name"];
  it("shows the count as a status and no 'No results' for an empty list", () => {
    const out = html(h(ListFilter, { placeholder: "Filter", head, rows: [] }));
    expect(out).toContain('role="status"');
    expect(out).toContain("0 items");
    expect(out).not.toContain("No results");
  });
  it("renders the rows it is given", () => {
    const rows = [{ key: "a", state: "ok", text: "alpha", row: h("tr", null, h("td", null, "alpha")) }];
    const out = html(h(ListFilter, { placeholder: "Filter", head, rows }));
    expect(out).toContain("1 item<");
    expect(out).toContain("<td>alpha</td>");
  });
});

describe("holdRefresh", () => {
  it("counts holds and releases each only once", () => {
    const base = holdCount();
    const a = holdRefresh();
    const b = holdRefresh();
    expect(holdCount()).toBe(base + 2);
    a();
    a();
    expect(holdCount()).toBe(base + 1);
    b();
    b();
    expect(holdCount()).toBe(base);
  });

  it("a closed dialog or menu holds nothing; an open one holds until it closes (J3)", () => {
    const base = holdCount();
    expect(holdWhile(false)).toBeUndefined();
    expect(holdWhile(undefined as unknown as boolean)).toBeUndefined();
    expect(holdCount()).toBe(base);
    const release = holdWhile(true);
    expect(holdCount()).toBe(base + 1);
    release?.();
    expect(holdCount()).toBe(base);
  });
});
