import { describe, expect, it } from "vitest";
import { buildFacts, nodeMajor, type RawFacts } from "./facts";

const pkg = (o: object) => JSON.stringify(o);
const raw = (o: Partial<RawFacts> = {}): RawFacts => ({
  framework: "nextjs", rootDir: null, lockfile: "npm", nextConfig: null, envNames: ["DATABASE_URL"], exampleNames: null,
  packageJson: pkg({ engines: { node: ">=20" }, scripts: { build: "next build", start: "next start", lint: "eslint ." } }),
  ...o,
});
const facts = (o: Partial<RawFacts> = {}) => {
  const r = buildFacts(raw(o));
  if (!r.ok) throw new Error(r.error);
  return r.facts;
};

describe("nodeMajor", () => {
  it("reads the lowest major a range allows", () => {
    expect(nodeMajor(">=18.17 <23")).toBe(18);
    expect(nodeMajor("^20")).toBe(20);
    expect(nodeMajor("22.x")).toBe(22);
  });
  it("is null for what isn't a version range", () => {
    expect(nodeMajor("lts")).toBeNull();
    expect(nodeMajor(undefined)).toBeNull();
  });
});

describe("buildFacts", () => {
  it("reads a Next.js app", () => {
    expect(facts({ nextConfig: `const c = { output: "standalone" }; export default c;` })).toEqual({
      kind: "nextjs", dir: ".", pm: "npm", node: 20, standalone: true, envNames: ["DATABASE_URL"], port: 3000, guessed: [],
      scripts: { build: true, start: true, lint: true, test: false, typecheck: null },
    });
  });
  it("serves Vite and Create React App builds on port 8080 (unprivileged nginx)", () => {
    expect(facts({ framework: "vite" })).toMatchObject({ kind: "vite", port: 8080, standalone: false });
    expect(facts({ framework: "create-react-app" })).toMatchObject({ kind: "cra", port: 8080 });
  });
  it("treats an app with a start script and no framework as plain Node", () => {
    expect(facts({ framework: null })).toMatchObject({ kind: "node", port: 3000 });
  });
  it("refuses a framework it has no templates for", () => {
    expect(buildFacts(raw({ framework: "nuxtjs" }))).toEqual({ ok: false, error: "Watchbell can't write build files for nuxtjs yet." });
    expect(buildFacts(raw({ framework: null, packageJson: pkg({ scripts: { build: "x" } }) }))).toEqual({ ok: false, error: "Watchbell can't write build files for this app yet: it has no framework and no start script." });
  });
  it("says what it had to guess", () => {
    const f = facts({ lockfile: null, packageJson: pkg({ scripts: { start: "node ." } }), envNames: null, exampleNames: null });
    expect(f).toMatchObject({ pm: "npm", node: 24, envNames: [] });
    expect(f.guessed).toEqual(["package manager", "Node version", "env names"]);
  });
  it("falls back to .env.example names, and drops Vercel's own", () => {
    expect(facts({ envNames: null, exampleNames: ["B", "A", "VERCEL_URL", "NODE_ENV", "bad name"] }).envNames).toEqual(["A", "B"]);
  });
  it("guesses the scripts when package.json can't be read", () => {
    const f = facts({ packageJson: null });
    expect(f.guessed).toContain("scripts");
    expect(f.scripts).toEqual({ build: true, start: true, lint: false, test: false, typecheck: null });
  });
  it("keeps the Root Directory", () => {
    expect(facts({ rootDir: "apps/web" }).dir).toBe("apps/web");
  });
  it("reads typecheck and type-check scripts", () => {
    expect(facts({ packageJson: pkg({ scripts: { start: "x", "type-check": "tsc" } }) }).scripts.typecheck).toBe("type-check");
  });
});

describe("nodeMajor, review fix M3", () => {
  it("takes the lowest major a range allows, not the first number", () => {
    expect(nodeMajor("<23 >=18")).toBe(18);
    expect(nodeMajor("^22 || ^20")).toBe(20);
    expect(nodeMajor("<20")).toBeNull();
  });
});

describe("Node floor, minor fix M3", () => {
  it("raises an end-of-life Node to 20 and says so", () => {
    const r = buildFacts(raw({ packageJson: pkg({ engines: { node: ">=18" }, scripts: { start: "x" } }) }));
    expect(r.ok && r.facts.node).toBe(20);
    expect(r.ok && r.facts.guessed).toContain("Node version (raised from 18 to 20)");
  });
});
