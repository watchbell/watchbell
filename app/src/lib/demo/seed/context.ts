import type { Db } from "@/db/client";

// What every seed module gets: the visitor's database (inside the seeding transaction), the seed, the time the rows are
// placed relative to, and the visitor's email.
export type SeedDb = Pick<Db, "insert" | "execute">;
export type SeedCtx = { db: SeedDb; seed: string; now: Date; email: string };

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

// A Postgres array literal for a `$n::type[]` parameter: one text parameter instead of thousands, so a bulk insert is a
// single short statement (`insert … select … from unnest(…)`). Only numbers, booleans and null go in, never text.
export const pgArray = (values: readonly (number | boolean | null)[]): string =>
  `{${values.map((v) => (v === null ? "NULL" : typeof v === "boolean" ? (v ? "t" : "f") : String(v))).join(",")}}`;
