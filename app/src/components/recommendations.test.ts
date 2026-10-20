import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Rec } from "@/lib/advisor/rules";

vi.mock("@/app/(console)/advisor-actions", () => ({ dismissRecommendation: vi.fn() }));

import { Recommendations } from "./recommendations";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const a: Rec = { key: "next-eol:a1:15", severity: "warning", appId: "a1", subject: "webs-ticketer", title: "Next.js 15 reaches end of life on 21 Oct 2026", why: "No security fixes after that date.", fix: "Upgrade to Next.js 16.", href: "https://endoflife.date/nextjs" };
const b: Rec = { key: "monitor-root:m1:401", severity: "info", appId: "a1", subject: "webs-ticketer", title: "The monitor on / answers 401", why: "A login page makes it look down.", fix: "Point it at a health route.", href: "/uptime" };

describe("Recommendations", () => {
  it("titles the card with the count and says it is computed daily at 03:00", () => {
    const out = html(h(Recommendations, { items: [a, b], canDismiss: true, showSubject: true }));
    expect(out).toContain("Recommendations (2)");
    expect(out).toContain("Daily at 03:00");
    expect(out).toContain("Computed");
  });
  it("shows the subject on Overview only, with why and fix under the title", () => {
    const on = html(h(Recommendations, { items: [a], canDismiss: false, showSubject: true }));
    expect(on).toContain("· webs-ticketer");
    expect(on).toContain("No security fixes after that date. Upgrade to Next.js 16.");
    expect(html(h(Recommendations, { items: [a], canDismiss: false, showSubject: false }))).not.toContain("webs-ticketer");
  });
  it("opens an external fix in a new tab and an internal one in the console", () => {
    const out = html(h(Recommendations, { items: [a, b], canDismiss: false, showSubject: false }));
    expect(out).toContain('href="https://endoflife.date/nextjs" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="/uptime"');
    expect(out.match(/target="_blank"/g)).toHaveLength(1);
    expect(out).toContain("How to fix");
  });
  it("treats only an http(s):// address as external", () => {
    const out = html(h(Recommendations, { items: [{ ...b, href: "/httpfoo" }, { ...b, key: "k2", href: "http://example.com/x" }], canDismiss: false, showSubject: false }));
    expect(out.match(/target="_blank"/g)).toHaveLength(1);
    expect(out).toContain('href="http://example.com/x" target="_blank"');
  });
  it("offers Dismiss only to someone who can act", () => {
    expect(html(h(Recommendations, { items: [a], canDismiss: true, showSubject: false }))).toContain(">Dismiss<");
    expect(html(h(Recommendations, { items: [a], canDismiss: false, showSubject: false }))).not.toContain("Dismiss");
  });
  it("says nothing needs tidying when empty, and is hidden on an app page", () => {
    const out = html(h(Recommendations, { items: [], canDismiss: true, showSubject: true }));
    expect(out).toContain("Nothing to tidy up");
    expect(out).toContain("The daily check found no hygiene items.");
    expect(out).toContain("Recommendations (0)");
    expect(html(h(Recommendations, { items: [], canDismiss: true, showSubject: false, hideWhenEmpty: true }))).toBe("");
  });
  it("shows at most `max` items and counts the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...b, key: `k${i}`, title: `Item ${i}` }));
    const out = html(h(Recommendations, { items: many, canDismiss: false, showSubject: true, max: 10 }));
    expect(out).toContain("Recommendations (13)");
    expect(out).toContain("Item 9");
    expect(out).not.toContain("Item 10");
    expect(out).toContain("+3 more");
  });
  it("renders the 5c slots it is given (summary above the notes), and keeps a card with notes even when empty", () => {
    const out = html(h(Recommendations, { items: [a], canDismiss: false, showSubject: true, summary: h("p", null, "AI-SUMMARY"), notes: h("p", null, "AI-NOTES") }));
    expect(out.indexOf("AI-SUMMARY")).toBeGreaterThan(-1);
    expect(out.indexOf("AI-SUMMARY")).toBeLessThan(out.indexOf("AI-NOTES"));
    expect(out.indexOf("AI-NOTES")).toBeLessThan(out.indexOf("Next.js 15"));
    expect(html(h(Recommendations, { items: [], canDismiss: false, showSubject: false, hideWhenEmpty: true }))).toBe("");
    expect(html(h(Recommendations, { items: [], canDismiss: false, showSubject: false, hideWhenEmpty: true, notes: h("p", null, "AI-NOTES") }))).toContain("AI-NOTES");
  });
});
