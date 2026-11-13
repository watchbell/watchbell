import { describe, expect, it } from "vitest";
import type { Host, LangTile } from "@/data/hosting";
import { afterDeploy, handoffHint, langAfterRepo, langForRepo, nextStep, watchLine } from "./target";

const vercel: Host = { id: "vercel", name: "Vercel", cost: "free", price: "Free", from: "git / CLI", newUrl: "https://vercel.com/new", provider: "vercel", source: "https://vercel.com/pricing" };
const render: Host = { id: "render", name: "Render", cost: "free", price: "Free", from: "git / Docker", newUrl: "https://dashboard.render.com/", menu: "New › Web Service", source: "https://render.com/pricing" };
const aws: Host = { id: "aws", name: "AWS", cost: "guide", price: "Guide", from: "Console", newUrl: "https://console.aws.amazon.com/", guide: ["Create an account.", "Add the address to Uptime."], source: "https://aws.amazon.com/free/" };

const LANGS: LangTile[] = [
  { id: "nextjs", label: "Next.js", github: [], fits: ["JavaScript", "TypeScript"], note: "n", hosts: [{ host: "vercel", catch: "c" }] },
  { id: "node", label: "Node.js", github: ["JavaScript", "TypeScript"], note: "n", hosts: [{ host: "render", catch: "c" }] },
  { id: "python", label: "Python", github: ["Python", "Jupyter Notebook"], note: "n", hosts: [{ host: "render", catch: "c" }] },
  { id: "static", label: "Static site", github: ["HTML", "CSS"], note: "n", hosts: [{ host: "vercel", catch: "c" }] },
];

const none = new Set<"vercel">();
const both = new Set<"vercel">(["vercel"]);

describe("langForRepo", () => {
  it("maps GitHub's language name to a tile, ignoring case", () => {
    expect(langForRepo("Python", LANGS)).toBe("python");
    expect(langForRepo("typescript", LANGS)).toBe("node");
    expect(langForRepo("HTML", LANGS)).toBe("static");
  });
  it("returns null for a language without a tile, or none at all", () => {
    expect(langForRepo("Shell", LANGS)).toBeNull();
    expect(langForRepo(null, LANGS)).toBeNull();
    expect(langForRepo("", LANGS)).toBeNull();
  });
});

describe("handoffHint", () => {
  it("says which menu to use and which repository to pick there", () => {
    expect(handoffHint(render, "acme/shop")).toBe("On Render: New › Web Service, then pick acme/shop.");
    expect(handoffHint(render, null)).toBe("On Render: New › Web Service.");
    expect(handoffHint(vercel, "acme/my.repo")).toBe("On Vercel: import acme/my.repo from GitHub.");
    expect(handoffHint(vercel, null)).toBe("On Vercel: import your repository from GitHub.");
  });
  it("doesn't ask to pick a repository where there is none to pick, and names it where the menu does (review M1)", () => {
    const ftp: Host = { ...render, name: "InfinityFree", menu: "create a hosting account, then upload the files over FTP", picksRepo: false };
    expect(handoffHint(ftp, "acme/site")).toBe("On InfinityFree: create a hosting account, then upload the files over FTP.");
    const pages: Host = { ...render, name: "GitHub Pages", menu: "open {repo} on GitHub, then Settings › Pages", picksRepo: false };
    expect(handoffHint(pages, "acme/site")).toBe("On GitHub Pages: open acme/site on GitHub, then Settings › Pages.");
    expect(handoffHint(pages, null)).toBe("On GitHub Pages: open the repository on GitHub, then Settings › Pages.");
  });
});

describe("nextStep", () => {
  it("a connected host: open its own new-project page; the repository never goes into the link (the documented pre-fills copy it)", () => {
    expect(nextStep(vercel, { connected: both, owner: false })).toEqual({ kind: "deploy", label: "Deploy on Vercel", href: "https://vercel.com/new" });
  });
  it("a Watchbell host that isn't connected: the owner connects it first, others ask the owner", () => {
    expect(nextStep(vercel, { connected: none, owner: true })).toEqual({ kind: "connect", label: "Connect Vercel first", href: "/connections?provider=vercel" });
    expect(nextStep(vercel, { connected: none, owner: false })).toEqual({ kind: "ask", label: "Ask the owner to connect Vercel" });
  });
  it("a connection that fails: the owner fixes it on Connections, others ask; never 'Deploy' while sync is broken", () => {
    const broken = new Set<"vercel">(["vercel"]);
    expect(nextStep(vercel, { connected: none, broken, owner: true })).toEqual({ kind: "connect", label: "Fix the Vercel connection", href: "/connections?provider=vercel" });
    expect(nextStep(vercel, { connected: none, broken, owner: false })).toEqual({ kind: "ask", label: "Ask the owner to fix the Vercel connection" });
    expect(nextStep(vercel, { connected: both, broken, owner: true }).kind).toBe("deploy");
  });
  it("a host Watchbell doesn't connect to: deploy on it directly", () => {
    expect(nextStep(render, { connected: none, owner: false })).toEqual({ kind: "deploy", label: "Deploy on Render", href: "https://dashboard.render.com/" });
  });
  it("a guide-only host shows its steps and never claims a deploy", () => {
    expect(nextStep(aws, { connected: both, owner: true })).toEqual({ kind: "guide", label: "Show the steps", steps: aws.guide });
  });
});

describe("what Watchbell does afterwards (review I2)", () => {
  it("claims syncing only while the connection works", () => {
    expect(watchLine(vercel, { connected: both, broken: none })).toBe("Syncs it: deployments, logs and uptime");
    expect(watchLine(vercel, { connected: none, broken: none })).toBe("Syncs it once Vercel is connected");
    expect(watchLine(vercel, { connected: none, broken: new Set(["vercel"]) })).toBe("Connection failing: fix it to sync");
    expect(watchLine(render, { connected: both, broken: none })).toBe("Uptime checks only");
  });
  it("says where a new Vercel project turns up, since new projects aren't watched by default", () => {
    expect(afterDeploy(vercel)).toBe("After the next sync (daily, or Sync now) it's listed under Sync on Connections: tick it there, or turn on Watch new ones automatically.");
    expect(afterDeploy(render)).toBe("When it's live, add its address to Uptime.");
  });
});

describe("langAfterRepo (review I4)", () => {
  const next = LANGS[0];
  it("keeps a tile the repository fits: a TypeScript repo stays on Next.js", () => {
    expect(langAfterRepo(next, "TypeScript", false, LANGS)).toBe("nextjs");
  });
  it("moves to the repository's language when the tile doesn't fit and the user hasn't picked one", () => {
    expect(langAfterRepo(next, "Python", false, LANGS)).toBe("python");
  });
  it("never overrides a tile the user picked, and keeps the tile for an unknown language", () => {
    expect(langAfterRepo(next, "Python", true, LANGS)).toBe("nextjs");
    expect(langAfterRepo(next, "Shell", false, LANGS)).toBe("nextjs");
  });
});
