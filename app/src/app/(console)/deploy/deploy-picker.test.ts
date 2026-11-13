import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AliasProvider } from "@/components/alias";
import type { Host, LangTile } from "@/data/hosting";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { DeployPicker, type PickerProps } from "./deploy-picker";

const HOSTS: Record<string, Host> = {
  vercel: { id: "vercel", name: "Vercel", cost: "free", price: "Free", from: "git / CLI", newUrl: "https://vercel.com/new", provider: "vercel", source: "https://vercel.com/pricing" },
  render: { id: "render", name: "Render", cost: "free", price: "Free", from: "git / Docker", newUrl: "https://dashboard.render.com/", menu: "New › Web Service", source: "https://render.com/pricing" },
  railway: { id: "railway", name: "Railway", cost: "trial", price: "$5 trial", from: "git / Docker", newUrl: "https://railway.com/new", source: "https://railway.com/pricing" },
  aws: { id: "aws", name: "AWS", cost: "guide", price: "Guide", from: "Console", newUrl: "https://console.aws.amazon.com/", guide: ["Make an account.", "Add the address to Uptime."], source: "https://aws.amazon.com/free/" },
};
const LANGS: LangTile[] = [
  { id: "nextjs", label: "Next.js", github: [], fits: ["JavaScript", "TypeScript"], note: "Vercel Hobby is the best free host for Next.js.", hosts: [{ host: "vercel", catch: "Non-commercial only" }, { host: "render", catch: "Sleeps after 15 min" }] },
  { id: "python", label: "Python", github: ["Python"], note: "Render runs Django or FastAPI for free.", hosts: [{ host: "render", catch: "Sleeps after 15 min" }, { host: "railway", catch: "Trial credit, then $5/mo" }, { host: "aws", catch: "You run it yourself" }] },
];

const base: PickerProps = {
  langs: LANGS, hosts: HOSTS, github: true, connected: ["vercel"], owner: true,
  repos: [{ fullName: "acme/shop", language: "TypeScript", private: false }, { fullName: "acme/api", language: "Python", private: true }],
};
const wrap = (child: ReactNode, shot = false) => renderToStaticMarkup(h(AliasProvider, { book: EMPTY_BOOK, shot, children: child }));
const render = (p: Partial<PickerProps> = {}, shot = false) => wrap(h(DeployPicker, { ...base, ...p }), shot);

describe("DeployPicker (Hosting › Deploy an app)", () => {
  it("starts on the first language and its first (free) host, with that host's button", () => {
    const out = render();
    expect(out).toMatch(/aria-pressed="true"[^>]*>Next\.js</);
    expect(out).toContain("Vercel Hobby is the best free host for Next.js.");
    expect(out).toMatch(/aria-selected="true"[^>]*>[\s\S]*?Vercel/);
    expect(out).toContain("Non-commercial only");
    expect(out).toContain("Syncs it: deployments, logs and uptime");
    expect(out).toContain("Deploy on Vercel");
    expect(out).toContain('href="https://vercel.com/new"');
    expect(out).toContain("On Vercel: import your repository from GitHub.");
    expect(out).toContain('rel="noopener noreferrer"');
  });
  it("a repository chosen up front picks its language and is named in the hand-off, never put into the link", () => {
    const out = render({ initialRepo: "acme/api" });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Python</);
    expect(out).toContain("Deploy on Render");
    expect(out).toContain("On Render: New › Web Service, then pick acme/api.");
    expect(out).toContain('href="https://dashboard.render.com/"');
    expect(out).not.toContain("github.com%2Facme");
  });
  it("without GitHub there is nothing to pick; the owner gets a link to connect it", () => {
    const out = render({ github: false, repos: [] });
    expect(out).toContain("Connect GitHub to pick a repository");
    expect(out).toContain('href="/connections?provider=github"');
    expect(render({ github: false, repos: [], owner: false })).toContain("The owner can connect GitHub to pick a repository");
  });
  it("a host Watchbell syncs but isn't connected: the owner connects it, others ask", () => {
    expect(render({ connected: [] })).toContain("Connect Vercel first");
    expect(render({ connected: [], owner: false })).toContain("Ask the owner to connect Vercel");
  });
  it("a failing Vercel connection asks for a fix instead of offering a deploy", () => {
    expect(render({ connected: [], broken: ["vercel"] })).toContain("Fix the Vercel connection");
  });
  it("says why repositories have no language when GitHub couldn't tell", () => {
    expect(render({ repoNote: "Languages aren't shown: GitHub answered 403." })).toContain("Languages aren&#x27;t shown: GitHub answered 403.");
  });
  it("a Next.js repository (TypeScript) keeps Next.js and Vercel (review I4)", () => {
    const out = render({ initialRepo: "acme/shop" });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Next\.js</);
    expect(out).toContain("Deploy on Vercel");
  });
  it("screenshot mode hides the repository names (review I5)", () => {
    const out = render({ initialRepo: "acme/api" }, true).replace(/value="[^"]*"/g, "");
    expect(out).not.toContain("acme/api");
    expect(out).not.toContain("acme/shop");
  });
  it("a long repository name wraps instead of widening the page (review M6)", () => {
    expect(render({ initialRepo: "acme/api" })).toMatch(/\[overflow-wrap:anywhere\]/);
  });
  it("lets the host table scroll inside the card instead of widening the page on a phone", () => {
    expect(render()).toMatch(/^<div class="[^"]*grid-cols-\[minmax\(0,1fr\)\]/);
  });
  it("labels free, trial and guide-only hosts and says what Watchbell can do with each", () => {
    const out = render({ initialRepo: "acme/api" });
    expect(out).toContain("$5 trial");
    expect(out).toContain("Guide");
    expect(out).toContain("Uptime checks only");
    expect(out).toContain("When it&#x27;s live, add its address to Uptime.");
  });
});
