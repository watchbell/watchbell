// Watchbell 1.5 Build files (10b): the facts an app's Dockerfile, compose file, CI workflow and Kubernetes manifest are
// written from, normalised from what Watchbell already reads (the Vercel project, the repository's package.json,
// next.config and lockfile, the env names). Anything that can't be read falls back to a default and is listed in
// `guessed`, so the card can say so. Env names only, never values. Pure.

export type Kind = "nextjs" | "vite" | "cra" | "node";
export type PM = "npm" | "pnpm" | "yarn" | "bun";
// typecheck: the script's own name ("typecheck" or "type-check"), so CI can run it; null when there is none.
export type Scripts = { build: boolean; start: boolean; lint: boolean; test: boolean; typecheck: string | null };
export type BuildFacts = {
  kind: Kind; dir: string; pm: PM; node: number; scripts: Scripts; standalone: boolean; envNames: string[]; port: number; guessed: string[];
};
export type RawFacts = {
  framework: string | null; rootDir: string | null; lockfile: PM | null; packageJson: string | null; nextConfig: string | null;
  envNames: string[] | null; exampleNames: string[] | null;
};

// The current Node.js LTS line (Node 24 entered LTS in Oct 2025).
export const DEFAULT_NODE = 24;
export const MIN_NODE = 20;
const FRAMEWORKS: Record<string, Kind> = { nextjs: "nextjs", vite: "vite", "create-react-app": "cra" };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const isSystem = (k: string) => k === "NODE_ENV" || k.startsWith("VERCEL_") || k === "VERCEL";

// The lowest major a package.json engines range allows (">=18.17 <23" → 18), or null.
// Upper bounds ("<23") are skipped and the smallest lower bound wins, across "||" alternatives (review M3).
export function nodeMajor(range: string | undefined): number | null {
  if (typeof range !== "string") return null;
  const majors = range.split(/\s*\|\|\s*|\s+/)
    .filter((t) => t && !t.startsWith("<"))
    .map((t) => /^[>=^~v]*(\d{1,2})(?:\.(?:\d+|x|\*))*$/.exec(t))
    .flatMap((m) => (m ? [Number(m[1])] : []))
    .filter((n) => n >= 10 && n <= 40);
  return majors.length ? Math.min(...majors) : null;
}

function readPackage(text: string | null): { scripts: Scripts; node: number | null } | null {
  if (!text) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const o = j as { scripts?: unknown; engines?: { node?: unknown } };
  const s = typeof o.scripts === "object" && o.scripts !== null ? (o.scripts as Record<string, unknown>) : {};
  const has = (k: string) => typeof s[k] === "string";
  return {
    scripts: { build: has("build"), start: has("start"), lint: has("lint"), test: has("test"), typecheck: has("typecheck") ? "typecheck" : has("type-check") ? "type-check" : null },
    node: nodeMajor(typeof o.engines?.node === "string" ? o.engines.node : undefined),
  };
}

export function buildFacts(raw: RawFacts): { ok: true; facts: BuildFacts } | { ok: false; error: string } {
  const guessed: string[] = [];
  const pkg = readPackage(raw.packageJson);
  const scripts: Scripts = pkg?.scripts ?? { build: true, start: true, lint: false, test: false, typecheck: null };

  let kind: Kind;
  if (raw.framework && FRAMEWORKS[raw.framework]) kind = FRAMEWORKS[raw.framework];
  else if (raw.framework) return { ok: false, error: `Watchbell can't write build files for ${raw.framework} yet.` };
  else if (scripts.start) kind = "node";
  else return { ok: false, error: "Watchbell can't write build files for this app yet: it has no framework and no start script." };

  if (!raw.lockfile) guessed.push("package manager");
  let node = pkg?.node ?? null;
  if (node === null) guessed.push("Node version");
  // Node below 20 is past end of life (and Next.js 16 needs 20.9+): the image gets 20 and the card says so (M3).
  if (node !== null && node < MIN_NODE) {
    guessed.push(`Node version (raised from ${node} to ${MIN_NODE})`);
    node = MIN_NODE;
  }
  if (!pkg) guessed.push("scripts");
  const names = raw.envNames ?? raw.exampleNames;
  if (!names) guessed.push("env names");

  return {
    ok: true,
    facts: {
      kind, dir: raw.rootDir || ".", pm: raw.lockfile ?? "npm", node: node ?? DEFAULT_NODE, scripts,
      standalone: kind === "nextjs" && !!raw.nextConfig && /output\s*:\s*["'`]standalone["'`]/.test(raw.nextConfig),
      envNames: [...new Set((names ?? []).filter((k) => ENV_NAME.test(k) && !isSystem(k)))].sort(),
      // Static builds are served by the unprivileged nginx image, which listens on 8080 (never as root).
      port: kind === "vite" || kind === "cra" ? 8080 : 3000,
      guessed,
    },
  };
}
