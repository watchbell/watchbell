// What a demo visitor is told when the demo server can't take them right now. Client-safe: the error boundaries import
// it. A server error reaches the browser only as its digest (never its message), so these errors carry a fixed digest
// that the boundary maps back to the message. Server Actions get the message itself (runGuarded, lib/action.ts).
export const DEMO_BUSY = "The demo is busy right now. Try again in a minute.";
export const DEMO_TOO_MANY = "Too many new demo sessions from your network. Try again in a few minutes.";

const BY_DIGEST = new Map<string, string>([
  ["watchbell-demo-busy", DEMO_BUSY],
  ["watchbell-demo-too-many", DEMO_TOO_MANY],
]);
const DIGEST_OF = new Map([...BY_DIGEST].map(([digest, message]) => [message, digest]));

export type DemoNotice = typeof DEMO_BUSY | typeof DEMO_TOO_MANY;

// An Error whose message is the notice and whose digest Next.js passes to the error boundary unchanged.
export function demoNoticeError(message: DemoNotice): Error & { digest: string } {
  return Object.assign(new Error(message), { digest: DIGEST_OF.get(message)! });
}

// The notice for an error boundary's digest, or null for any other error.
export function demoNoticeForDigest(digest: string | undefined): string | null {
  return typeof digest === "string" ? (BY_DIGEST.get(digest) ?? null) : null;
}

// The notice an error carries, also when it arrives wrapped (Drizzle wraps a failed query's error as `cause`).
export function demoNoticeOf(e: unknown): string | null {
  for (let cur = e, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const notice = demoNoticeForDigest((cur as { digest?: string }).digest);
    if (notice && cur instanceof Error && cur.message === notice) return notice;
  }
  return null;
}
