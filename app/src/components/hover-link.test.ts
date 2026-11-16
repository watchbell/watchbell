import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], prefetch: vi.fn() }));
vi.mock("next/link", () => ({ default: (p: Record<string, unknown>) => { m.props.push(p); return null; } }));

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { HoverLink } from "./hover-link";

// 1.8.1: one workspace switch made the browser re-prefetch every link at once (64 server renders measured on 16 Nov),
// each holding a pooler slot on Vercel. Final review C1: a link switched to Next's own prefetch on hover joins Next's
// list of visible links and is fetched again on every refresh and server action for the rest of the session, so the
// burst came back once the pointer had passed over the sidebar. HoverLink never hands prefetching to Next: it asks
// for the page once, when the pointer, focus or a touch reaches it.
beforeEach(() => {
  m.props.length = 0;
  m.prefetch.mockReset();
});

const render = (href: unknown) => {
  renderToStaticMarkup(h(AppRouterContext.Provider, { value: { prefetch: m.prefetch } as never }, h(HoverLink, { href, children: "Apps" } as never)));
  return m.props.at(-1)!;
};
const fire = (p: Record<string, unknown>, name: string) => (p[name] as (e: unknown) => void)({});

describe("HoverLink", () => {
  it("never lets Next prefetch the link on its own", () => {
    expect(render("/apps").prefetch).toBe(false);
  });

  it("prefetches once on pointer, focus or touch, never again", () => {
    const p = render("/apps");
    fire(p, "onMouseEnter");
    fire(p, "onFocus");
    fire(p, "onTouchStart");
    fire(p, "onMouseEnter");
    expect(m.prefetch).toHaveBeenCalledTimes(1);
    expect(m.prefetch).toHaveBeenCalledWith("/apps");
  });

  it("leaves non-string hrefs alone", () => {
    fire(render({ pathname: "/apps" }), "onMouseEnter");
    expect(m.prefetch).not.toHaveBeenCalled();
  });

  it("nothing but HoverLink imports next/link", () => {
    const src = join(process.cwd(), "src");
    const direct = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !/hover-link\.tsx$/.test(f))
      .filter((f) => /from "next\/link"/.test(readFileSync(join(src, f), "utf8")));
    expect(direct).toEqual([]);
  });
});

describe("HoverLink without an app router (components rendered on their own)", () => {
  it("renders and ignores the pointer instead of throwing", () => {
    renderToStaticMarkup(h(HoverLink, { href: "/apps", children: "Apps" } as never));
    fire(m.props.at(-1)!, "onMouseEnter");
    expect(m.prefetch).not.toHaveBeenCalled();
  });
});

