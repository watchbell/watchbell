import { describe, expect, it } from "vitest";
import { type Block, type Inline, joinPath, parseMarkdown, safeHref, safeImage, stripHtml } from "./markdown";

const pub = { fullName: "me/site", ref: "main", dir: "", isPrivate: false };
const priv = { ...pub, isPrivate: true };

// Every link and image in a parsed tree.
function walk(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  const inl = (l: Inline[]) => l.forEach((n) => { out.push(n); if ("c" in n) inl(n.c); });
  const blk = (bs: Block[]) => bs.forEach((b) => {
    if (b.t === "h" || b.t === "p") inl(b.c);
    if (b.t === "quote") blk(b.c);
    if (b.t === "list") b.items.forEach(blk);
    if (b.t === "table") { b.head.forEach(inl); b.rows.forEach((r) => r.forEach(inl)); }
  });
  blk(blocks);
  return out;
}
const text = (blocks: Block[]) => walk(blocks).filter((n) => n.t === "text" || n.t === "code").map((n) => ("v" in n ? n.v : "")).join("");

describe("README sanitizing", () => {
  it("drops scripts, styles, iframes and event handlers with their content", () => {
    const t = parseMarkdown("Hi <script>alert(1)</script> there <style>p{}</style><iframe src=x></iframe><b onclick=\"x()\">bold</b>", pub);
    expect(text(t)).toBe("Hi  there bold");
    expect(JSON.stringify(t)).not.toMatch(/alert|onclick|iframe/);
  });

  it("drops an unclosed script to the end", () => {
    expect(text(parseMarkdown("ok <script>steal()", pub))).toBe("ok");
  });

  it("keeps only http(s) links", () => {
    const links = walk(parseMarkdown("[a](javascript:alert(1)) [b](https://ex.com/x) [c](data:text/html,hi) [d](mailto:me@ex.com) [e](#top) [f](//evil.com)", pub)).filter((n) => n.t === "a");
    expect(links).toEqual([{ t: "a", href: "https://ex.com/x", c: [{ t: "text", v: "b" }] }]);
  });

  it("points relative links at the file on GitHub", () => {
    const [a] = walk(parseMarkdown("[docs](docs/setup.md)", { ...pub, dir: "packages/web" })).filter((n) => n.t === "a");
    expect(a).toMatchObject({ href: "https://github.com/me/site/blob/main/packages/web/docs/setup.md" });
  });

  it("keeps images only from GitHub hosts", () => {
    const imgs = walk(parseMarkdown("![a](https://raw.githubusercontent.com/me/site/main/a.png) ![b](https://evil.com/t.gif) ![c](http://github.com/x.png) ![d](https://user-images.githubusercontent.com/1/x.png) ![e](https://img.shields.io/badge/x)", pub));
    expect(imgs.filter((n) => n.t === "img").map((n) => (n as { src: string }).src)).toEqual(["https://raw.githubusercontent.com/me/site/main/a.png", "https://user-images.githubusercontent.com/1/x.png"]);
    // The rest keep their alt text.
    expect(text(parseMarkdown("![b](https://evil.com/t.gif)", pub))).toBe("b");
  });

  it("reads a relative image from raw.githubusercontent.com for a public repository only", () => {
    expect(walk(parseMarkdown("![logo](./img/logo.png)", pub))).toContainEqual({ t: "img", src: "https://raw.githubusercontent.com/me/site/main/img/logo.png", alt: "logo" });
    expect(walk(parseMarkdown("![logo](./img/logo.png)", priv)).some((n) => n.t === "img")).toBe(false);
  });

  it("turns HTML images and links into safe markdown", () => {
    const t = parseMarkdown('<p align="center"><a href="https://ex.com"><img src="https://github.com/me/site/raw/main/x.png" alt="X" onerror="hack()"></a></p>', pub);
    const all = walk(t);
    expect(all).toContainEqual({ t: "img", src: "https://github.com/me/site/raw/main/x.png", alt: "X" });
    expect(all.find((n) => n.t === "a")).toMatchObject({ href: "https://ex.com/" });
    expect(JSON.stringify(t)).not.toContain("hack");
  });

  it("leaves HTML inside code alone (as text)", () => {
    const t = parseMarkdown("Use `<Button onClick>` here.\n\n```html\n<script>x()</script>\n```", pub);
    expect(t[0]).toEqual({ t: "p", c: [{ t: "text", v: "Use " }, { t: "code", v: "<Button onClick>" }, { t: "text", v: " here." }] });
    expect(t[1]).toEqual({ t: "code", lang: "html", text: "<script>x()</script>" });
  });

  it("decodes entities to text (React escapes them again)", () => {
    expect(text(parseMarkdown("a &lt;b&gt; &amp; &#169; &#x2014;", pub))).toBe("a <b> & © —");
  });
});

describe("markdown blocks", () => {
  it("parses headings, lists, quotes, rules and tables", () => {
    const t = parseMarkdown("# Title\n\nSub\n---\n\n- one\n- **two**\n  - nested\n\n1. a\n2. b\n\n> quoted\n\n***\n\n| a | b |\n|:--|--:|\n| 1 | `2` |", pub);
    expect(t.map((b) => b.t)).toEqual(["h", "h", "list", "list", "quote", "hr", "table"]);
    expect(t[1]).toEqual({ t: "h", level: 2, c: [{ t: "text", v: "Sub" }] });
    const ul = t[2] as Extract<Block, { t: "list" }>;
    expect(ul.items).toHaveLength(2);
    expect(ul.items[1][1]).toMatchObject({ t: "list", ordered: false });
    const table = t[6] as Extract<Block, { t: "table" }>;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows[0][1]).toEqual([{ t: "code", v: "2" }]);
  });

  it("resolves reference links and badges", () => {
    const t = parseMarkdown("[![build][badge]][ci]\n\n[badge]: https://github.com/me/site/actions/workflows/ci.yml/badge.svg\n[ci]: https://github.com/me/site/actions", pub);
    expect(t).toHaveLength(1);
    const a = walk(t).find((n) => n.t === "a");
    expect(a).toEqual({ t: "a", href: "https://github.com/me/site/actions", c: [{ t: "img", src: "https://github.com/me/site/actions/workflows/ci.yml/badge.svg", alt: "build" }] });
  });

  it("keeps snake_case words and handles emphasis", () => {
    expect(parseMarkdown("my_var_name and *em* and __strong__ and ~~gone~~", pub)[0]).toEqual({ t: "p", c: [
      { t: "text", v: "my_var_name and " }, { t: "em", c: [{ t: "text", v: "em" }] }, { t: "text", v: " and " },
      { t: "strong", c: [{ t: "text", v: "strong" }] }, { t: "text", v: " and " }, { t: "del", c: [{ t: "text", v: "gone" }] },
    ] });
  });

  it("autolinks bare URLs without trailing punctuation", () => {
    expect(walk(parseMarkdown("See https://ex.com/docs.", pub)).find((n) => n.t === "a")).toMatchObject({ href: "https://ex.com/docs" });
  });

  it("stays bounded on deep nesting", () => {
    const deep = `${"> ".repeat(200)}x`;
    expect(() => parseMarkdown(deep, pub)).not.toThrow();
    const brackets = "[".repeat(5000);
    expect(() => parseMarkdown(brackets, pub)).not.toThrow();
  });
});

describe("URL helpers", () => {
  it("joins paths without climbing out", () => {
    expect(joinPath("docs", "../img/a.png")).toBe("img/a.png");
    expect(joinPath("", "../a")).toBeNull();
    expect(joinPath("a/b", "/root.md")).toBe("root.md");
  });

  it("refuses odd schemes and credentials in image URLs", () => {
    expect(safeHref("JaVaScRiPt:alert(1)", pub)).toBeNull();
    expect(safeImage("https://user:pw@raw.githubusercontent.com/x.png", pub)).toBeNull();
    expect(safeImage("https://raw.githubusercontent.com.evil.com/x.png", pub)).toBeNull();
  });

  it("strips tags but keeps their text", () => {
    expect(stripHtml("<kbd>Ctrl</kbd>+<kbd>C</kbd>")).toBe("Ctrl+C");
  });
});
