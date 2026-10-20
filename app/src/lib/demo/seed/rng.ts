import { createHash } from "node:crypto";

// Deterministic randomness for the demo seed. Every module draws from its own named stream (rngFor(seed, "apps")), so
// adding a module or a draw in one never shifts another module's rows. Ids come from a hash of the seed and a path
// (stableId), never from the order of the draws: a visitor whose database was evicted gets the same ids back, so the
// links they have open (/apps/<id>) keep working.

export type Rng = {
  next(): number; // [0, 1)
  int(min: number, max: number): number; // inclusive
  pick<T>(list: readonly T[]): T;
  chance(p: number): boolean;
  shuffle<T>(list: readonly T[]): T[];
};

const digest = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("\u0000")).digest();

// mulberry32: small, fast and good enough for made-up numbers.
export function mulberry32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(seed: string, ...stream: (string | number)[]): Rng {
  const next = mulberry32(digest(seed, ...stream).readUInt32LE(0));
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    shuffle: (list) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

// A version-4-shaped uuid from the seed and a path such as ("app", 3).
export function stableId(seed: string, ...path: (string | number)[]): string {
  const b = digest(seed, "id", ...path);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Provider-style ids and hashes: "dpl_" + 24 base62, a 40-hex commit sha, a 9-char deployment url hash.
export function stableToken(length: number, seed: string, ...path: (string | number)[]): string {
  let out = "";
  for (let block = 0; out.length < length; block++) {
    for (const byte of digest(seed, "token", block, ...path)) out += BASE62[byte % 62];
  }
  return out.slice(0, length);
}

export function stableHex(length: number, seed: string, ...path: (string | number)[]): string {
  let out = "";
  for (let block = 0; out.length < length; block++) out += digest(seed, "hex", block, ...path).toString("hex");
  return out.slice(0, length);
}
