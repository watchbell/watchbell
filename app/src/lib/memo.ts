// 1.8.1 (public routes audit): the last answer of a read, kept per server instance for ttlMs; callers that arrive while
// it runs share it. For public pages only (sign-in brand, logo, status page slugs), so a flood of requests costs one
// database read per instance per ttl instead of one each. A failure is not kept. The writer calls clear() on its own
// instance; other instances catch up within ttlMs.
// skip(): read every time instead (final review I2: the demo, where each visitor has a database of their own).
export function ttlMemo<T>(fn: () => Promise<T>, ttlMs: number, clock: () => number = Date.now, skip: () => boolean = () => false) {
  let at = 0;
  let value: Promise<T> | null = null;
  return {
    get(): Promise<T> {
      if (skip()) return fn();
      const now = clock();
      if (value && now - at < ttlMs) return value;
      at = now;
      const p = fn();
      value = p;
      p.catch(() => { if (value === p) value = null; });
      return p;
    },
    clear(): void {
      value = null;
    },
  };
}
