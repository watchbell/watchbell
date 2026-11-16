import { PGlite, type PGliteOptions } from "@electric-sql/pglite";

// 1.8.1 (vitest setupFiles): every PGlite a test opens refuses what the cloud console's postgres-js driver refuses.
// Drizzle's postgres-js driver hands date/time and json parameters to the wire as they are, so anything but a string
// there throws in production; PGlite used to convert it, and a raw sql`` with a Date passed every test (15 Nov).
// int8 comes back as a string, as it does from postgres-js. Production code (self-host, demo) is not touched.
const REFUSE_NON_STRING = [1082, 1083, 1114, 1184, 114, 3802]; // date, time, timestamp, timestamptz, json, jsonb

const strict = (oid: number) => (x: unknown): string => {
  if (typeof x === "string") return x;
  const what = x instanceof Date ? "a Date" : Array.isArray(x) ? "an array" : typeof x;
  throw new TypeError(`postgres-js would refuse ${what} for type ${oid}: pass an ISO string (::timestamptz) or JSON.stringify(...) (::jsonb)`);
};

export const strictOptions = (options: PGliteOptions = {}): PGliteOptions => ({
  ...options,
  serializers: { ...Object.fromEntries(REFUSE_NON_STRING.map((oid) => [oid, strict(oid)])), ...options.serializers },
  parsers: { 20: (x: string) => x, ...options.parsers },
});

type Create = (dataDirOrOptions?: string | PGliteOptions, options?: PGliteOptions) => ReturnType<typeof PGlite.create>;
const original = PGlite.create.bind(PGlite) as Create;
(PGlite as unknown as { create: Create }).create = (a, b) =>
  typeof a === "string" || a === undefined ? original(a, strictOptions(b)) : original(strictOptions(a));
