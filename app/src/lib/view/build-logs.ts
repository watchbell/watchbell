// Task 4 build logs (owner 24 Oct): a deployment's build output as the drawer shows it. Pure, shared by the adapter
// (lib/providers/vercel-build-logs.ts) and the drawer, so the cap and the error rule are the same on both sides.

export type BuildLineKind = "stdout" | "stderr" | "command" | "delimiter";
export type BuildLine = { at: number | null; kind: BuildLineKind; text: string };
export type BuildLog = { lines: BuildLine[]; truncated: boolean };

// The drawer keeps the last 2,000 lines (no caching beyond the request).
export const MAX_BUILD_LINES = 2000;

// An error line: what Next.js, npm, pnpm, TypeScript and Vercel's builder print when a build breaks. Warnings and
// "0 errors" aren't; a file name like error-boundary.tsx isn't (word "error" followed by a letter or a dash is skipped).
const ERROR_RE = /(\berror(?![-\w])|\bERR!|\bERR_[A-Z_]+|\bfailed\b|exited with (?:code )?[1-9]|Module not found|command not found)/i;
const NOT_ERROR_RE = /^\s*(?:npm |pnpm |yarn )?(?:warn|warning)\b|\b0 (?:errors?|failed)\b/i;

export function isErrorLine(l: BuildLine): boolean {
  if (l.kind === "command" || l.kind === "delimiter") return false;
  return ERROR_RE.test(l.text) && !NOT_ERROR_RE.test(l.text);
}

export const firstErrorIndex = (lines: BuildLine[]): number => lines.findIndex(isErrorLine);

export function capLines(lines: BuildLine[], max = MAX_BUILD_LINES): BuildLog {
  return lines.length > max ? { lines: lines.slice(lines.length - max), truncated: true } : { lines, truncated: false };
}

// Demo mode: a made-up failed build, so the drawer can be tried without a provider call.
export const DEMO_BUILD_LOG: BuildLog = {
  truncated: false,
  lines: [
    { at: null, kind: "delimiter", text: "Running build in Washington, D.C., USA (East) – iad1" },
    { at: null, kind: "stdout", text: "Cloning github.com/example/shop (Branch: main, Commit: 4f2a9c1)" },
    { at: null, kind: "command", text: "npm install" },
    { at: null, kind: "stdout", text: "added 412 packages in 18s" },
    { at: null, kind: "command", text: "npm run build" },
    { at: null, kind: "stdout", text: "> next build" },
    { at: null, kind: "stdout", text: "  ▲ Next.js 16.4.1" },
    { at: null, kind: "stdout", text: "   Creating an optimized production build ..." },
    { at: null, kind: "stderr", text: "Failed to compile." },
    { at: null, kind: "stderr", text: "./app/checkout/page.tsx:12:7" },
    { at: null, kind: "stderr", text: "Type error: Property 'total' does not exist on type 'Cart'." },
    { at: null, kind: "stderr", text: 'Error: Command "npm run build" exited with 1' },
  ],
};
