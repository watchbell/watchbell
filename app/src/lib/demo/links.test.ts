import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalLink } from "@/components/external-link";
import { DeployRowActions } from "@/app/(console)/deployments/deploy-row-actions";
import { Markdown } from "@/app/(console)/repos/[id]/markdown";
import { outboundLinks } from "./links";

vi.mock("@/app/(console)/vercel-actions", () => ({}));

const saved = process.env.WATCHPOST_MODE;
afterEach(() => {
  if (saved === undefined) delete process.env.WATCHPOST_MODE;
  else process.env.WATCHPOST_MODE = saved;
});

describe("links out of the console", () => {
  it("are allowed in cloud and self-host, never in demo", () => {
    expect(outboundLinks({})).toBe(true);
    expect(outboundLinks({ WATCHPOST_MODE: "selfhost" })).toBe(true);
    expect(outboundLinks({ WATCHPOST_MODE: "demo" })).toBe(false);
  });

  it("ExternalLink is an <a> outside demo and plain text in demo", () => {
    const el = h(ExternalLink, { href: "https://github.com/example-org/acme-shop", target: "_blank", className: "mono" }, "example-org/acme-shop");
    delete process.env.WATCHPOST_MODE;
    expect(renderToStaticMarkup(el)).toBe('<a href="https://github.com/example-org/acme-shop" class="mono" target="_blank">example-org/acme-shop</a>');
    process.env.WATCHPOST_MODE = "demo";
    expect(renderToStaticMarkup(el)).toBe('<span class="mono">example-org/acme-shop</span>');
  });

  it("a deployment row offers Visit only when its server parent allows links out", () => {
    const d = { appId: "a1", appName: "acme-shop", externalId: "dpl_1", sha: "abc1234", url: "acme-shop-git-main-x1y2z3a4b.example" };
    const out = (visit: boolean) => renderToStaticMarkup(h(DeployRowActions, { d: { ...d, visit }, actions: [], logs: null }));
    expect(out(true)).toContain('href="https://acme-shop-git-main-x1y2z3a4b.example"');
    expect(out(false)).not.toContain("href=");
    expect(out(false)).not.toContain("Visit");
  });

  it("a README's links are plain text in demo", () => {
    const tree = [{ t: "p" as const, c: [{ t: "a" as const, href: "https://github.com/example-org/acme-shop", c: [{ t: "text" as const, v: "docs" }] }] }];
    delete process.env.WATCHPOST_MODE;
    expect(renderToStaticMarkup(h(Markdown, { tree }))).toContain('<a href="https://github.com/example-org/acme-shop" target="_blank"');
    process.env.WATCHPOST_MODE = "demo";
    const out = renderToStaticMarkup(h(Markdown, { tree }));
    expect(out).not.toContain("href=");
    expect(out).toContain("<span>docs</span>");
  });
});
