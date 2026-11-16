// 1.8.1 (driver audit): a side read that may fail without failing the page, the bell or a notice. It resolves the
// fallback, and leaves a server log line with the error's name and code: never its message, which can carry values
// from the query. A silent .catch(() => 0) hid the All workspaces bug on two pages (15 Nov).
export async function soft<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    logSoft(e, label);
    return fallback;
  }
}

// The log line alone, for a .catch that has its own fallback. Final review I1: drizzle wraps a failed query in an error
// named "Error" with no code (the query and its parameters in its message); the driver's error is its cause.
export function logSoft(e: unknown, label: string): void {
  const inner = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  const name = inner instanceof Error ? inner.name : typeof inner;
  const code = inner && typeof inner === "object" && "code" in inner ? (inner as { code?: unknown }).code : undefined;
  console.warn(`[watchbell] ${label} failed:`, name, code);
}
