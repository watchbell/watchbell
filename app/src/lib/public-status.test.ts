import { describe, expect, it } from "vitest";
import { badgeKey, badgeSvg, MAX_ON_PAGE, parseSlug, parseStatusPageForm, publicState } from "./public-status";

describe("parseSlug and badgeKey", () => {
  it("accepts short lowercase slugs only", () => {
    expect(parseSlug("acme")).toBe("acme");
    expect(parseSlug("my-apps-2")).toBe("my-apps-2");
    for (const bad of ["ab", "Acme", "a/b", "../x", "x".repeat(41), "a b c", "ac%2fme", "acme.svg", 7, null, undefined, ["acme"]]) expect(parseSlug(bad)).toBeNull();
  });
  it("turns a display name into a badge key", () => {
    expect(badgeKey("Wedding site")).toBe("wedding-site");
    expect(badgeKey("  Acme Shop!! ")).toBe("acme-shop");
    expect(badgeKey("Café")).toBe("cafe");
    expect(badgeKey("!!!")).toBe("monitor");
  });
  it("never ends a long key on a dash", () => {
    const k = badgeKey(`${"a".repeat(39)} b`);
    expect(k).toBe("a".repeat(39));
    expect(k).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});

describe("publicState", () => {
  it("never shows more than a word", () => {
    expect(publicState("ok", false, false)).toEqual({ state: "ok", label: "Operational" });
    expect(publicState("warn", false, false)).toEqual({ state: "warn", label: "Degraded" });
    expect(publicState("err", false, false)).toEqual({ state: "err", label: "Down" });
    expect(publicState("err", true, false)).toEqual({ state: "maint", label: "Maintenance" });
    expect(publicState("ok", false, true)).toEqual({ state: "unknown", label: "No data" });
    expect(publicState("unknown", false, false)).toEqual({ state: "unknown", label: "No data" });
  });
  it("shows any other stored state as No data", () => {
    for (const s of ["idle", "build", "paused", "info", "fail", "off", "maint"] as const) expect(publicState(s, false, false)).toEqual({ state: "unknown", label: "No data" });
  });
});

describe("badgeSvg", () => {
  it("draws a two-part badge and escapes text", () => {
    const svg = badgeSvg("uptime", "99.98%", "ok");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain(">uptime<");
    expect(svg).toContain(">99.98%<");
    expect(svg).toContain('fill="#17773f"');
    expect(badgeSvg("a<b>", "&", "err")).toContain("a&lt;b&gt;");
    expect(badgeSvg("x", "y", "err")).not.toContain("<script");
  });
  it("has a colour per state, and no link, script, image or external reference", () => {
    const fills = (["ok", "warn", "err", "maint", "unknown"] as const).map((t) => /x="\d+" width="\d+" height="20" fill="(#[0-9a-f]{6})"/.exec(badgeSvg("a", "b", t))?.[1]);
    expect(new Set(fills).size).toBe(5);
    const svg = badgeSvg(`"><script>alert(1)</script>`, `<a href="javascript:x">`, "warn");
    // With attribute values and text emptied, only the badge's own markup is left: no tag or attribute came from the input.
    const markup = svg.replace(/="[^"]*"/g, '=""').replace(/>[^<]*</g, "><");
    expect(new Set([...markup.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1]))).toEqual(new Set(["svg", "title", "rect", "g", "text"]));
    expect(new Set([...markup.matchAll(/\s([a-zA-Z:-]+)=/g)].map((m) => m[1])))
      .toEqual(new Set(["xmlns", "width", "height", "role", "aria-label", "fill", "x", "y", "font-family", "font-size"]));
    expect(svg).toContain("&quot;&gt;&lt;script&gt;");
  });
  it("cuts long text", () => {
    expect(badgeSvg("x".repeat(80), "y", "ok")).not.toContain("x".repeat(31));
  });
});

describe("parseStatusPageForm", () => {
  const id = "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";
  const b = "7f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f";

  it("validates the page and its monitors", () => {
    expect(parseStatusPageForm({ slug: "acme", title: " Acme' apps ", announcement: "", published: true, monitors: [{ monitorId: id, displayName: "Portfolio" }] }))
      .toEqual({ ok: true, value: { slug: "acme", title: "Acme' apps", announcement: null, published: true, monitors: [{ monitorId: id, displayName: "Portfolio", position: 0 }] } });
    expect(parseStatusPageForm({ slug: "x", title: "", published: true, monitors: [{ monitorId: "nope", displayName: "" }] }))
      .toEqual({ ok: false, fieldErrors: { slug: "Use 3–40 lowercase letters, digits or dashes.", title: "Give the page a title.", monitors: "Every monitor needs a public name." } });
  });
  it("refuses two monitors with the same public name", () => {
    expect(parseStatusPageForm({ slug: "acme", title: "T", published: false, monitors: [{ monitorId: id, displayName: "Web" }, { monitorId: b, displayName: "web" }] }))
      .toEqual({ ok: false, fieldErrors: { monitors: "Two monitors can't share a public name." } });
  });
  it("refuses the same monitor twice", () => {
    expect(parseStatusPageForm({ slug: "acme", title: "T", published: false, monitors: [{ monitorId: id, displayName: "Web" }, { monitorId: id, displayName: "Api" }] }))
      .toEqual({ ok: false, fieldErrors: { monitors: "A monitor can be on the page only once." } });
  });
  it("publishes only on a real true, keeps an announcement, and allows an empty list", () => {
    const r = parseStatusPageForm({ slug: "acme", title: "T", announcement: "  Moving tonight ", published: "true", monitors: [] });
    expect(r).toEqual({ ok: true, value: { slug: "acme", title: "T", announcement: "Moving tonight", published: false, monitors: [] } });
  });
  it("caps the lengths and the number of monitors (B5)", () => {
    const many = Array.from({ length: MAX_ON_PAGE + 1 }, (_, i) => ({ monitorId: `6f0d4c1e-7c55-4a0b-9d2e-${String(i).padStart(12, "0")}`, displayName: `M ${i}` }));
    expect(parseStatusPageForm({ slug: "acme", title: "T", published: true, monitors: many }))
      .toEqual({ ok: false, fieldErrors: { monitors: `A status page can show at most ${MAX_ON_PAGE} monitors.` } });
    const r = parseStatusPageForm({ slug: "acme", title: "t".repeat(200), announcement: "a".repeat(500), published: true, monitors: [{ monitorId: id, displayName: "n".repeat(100) }] });
    expect(r.ok && [r.value.title.length, r.value.announcement?.length, r.value.monitors[0].displayName.length]).toEqual([80, 200, 60]);
  });
  it("survives junk", () => {
    for (const junk of [null, undefined, "x", 7, [], { monitors: "x" }, { monitors: [null, 3] }]) expect(parseStatusPageForm(junk).ok).toBe(false);
  });
});
