import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Bone, PageSkeleton, SkeletonCards, SkeletonTable } from "@/components/skeleton";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("Skeleton (perf P1)", () => {
  it("a bone pulses in the console's sunken tone and stands still for reduced motion", () => {
    const out = html(h(Bone, { className: "h-4 w-20" }));
    expect(out).toContain("bg-sunken");
    expect(out).toContain("dark:bg-line"); // review m5: sunken is ~1.05:1 on the dark surface
    expect(out).toContain("animate-pulse");
    expect(out).toContain("motion-reduce:animate-none");
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toMatch(/gradient|shimmer/);
  });
  it("the page shows its crumbs and title at once, says it is loading, and placeholders the subtitle", () => {
    const out = html(h(PageSkeleton, { crumbs: ["Observe", "Uptime"], title: "Uptime", sub: true }));
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("<span>Observe</span>");
    expect(out).toContain(">Uptime</h1>");
    expect(out).toContain("Loading Uptime");
    expect(out).toContain("max-w-[620px]"); // the subtitle line
  });
  it("without a title (a dynamic or role-gated page) the heading is a bone too", () => {
    const out = html(h(PageSkeleton, { crumbs: ["Applications"] }));
    expect(out).not.toContain("<h1");
    expect(out).toContain("Loading page");
  });
  it("draws a table in the mockup's shape: header band, then the given number of rows and columns", () => {
    const out = html(h(SkeletonTable, { rows: 4, cols: 3 }));
    expect(out.match(/<tr/g)?.length).toBe(5);
    expect(out.match(/<th[ >]/g)?.length).toBe(3);
    expect(out).toContain("bg-surface-2");
    expect(out).toContain("rounded-lg border border-line bg-surface");
  });
  it("draws a row of summary cards", () => {
    const out = html(h(SkeletonCards, { count: 3 }));
    expect(out.match(/<section/g)?.length).toBe(3);
  });
});

describe("loading.tsx on every console route (perf P1)", () => {
  const root = join(process.cwd(), "src", "app", "(console)");
  const routes = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) return [];
    return [...(existsSync(join(p, "page.tsx")) ? [p] : []), ...routes(p)];
  });
  it("finds the routes", () => {
    expect(routes(root).length).toBeGreaterThan(15);
  });
  it.each(routes(root).map((p) => [p.slice(root.length + 1) || "."]))("%s has a loading.tsx", (rel) => {
    expect(existsSync(join(root, rel, "loading.tsx"))).toBe(true);
  });
});
