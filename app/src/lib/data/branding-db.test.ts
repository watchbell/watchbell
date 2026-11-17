import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { settings } from "@/db/schema";
import { logoVersionOf } from "@/lib/branding-version";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { fillLogoVersion, readBrand } from "./branding-db";

let client: PGlite;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
}, 60_000);
afterAll(async () => client?.close());

// 1.8.3 (1.7.1 note): a logo uploaded with 1.7.0 has no version (the version arrived in 1.7.1 and is written only with
// the logo), so its pages asked for a bare /brand-icon the CDN keeps 5 minutes. The first read fills the version in
// from the stored logo and saves it, so nobody has to upload the logo again.
describe("readBrand fills in a 1.7.0 logo's version", () => {
  it("computes the version from the stored logo once and keeps it", async () => {
    const db = h.db as ReturnType<typeof drizzle>;
    await db.insert(settings).values([
      { key: "branding", value: { name: "Kopi Senja", accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: true } },
      { key: "branding.logo", value: { png: Buffer.from(PNG).toString("base64") } },
    ]);
    const b = await readBrand();
    expect(b).toMatchObject({ name: "Kopi Senja", hasLogo: true, logoVersion: logoVersionOf(PNG) });
    const [row] = await db.select().from(settings).where((await import("drizzle-orm")).eq(settings.key, "branding"));
    expect((row.value as { logoVersion?: string }).logoVersion).toBe(logoVersionOf(PNG));
  });

  it("leaves a brand without a logo alone", async () => {
    const db = h.db as ReturnType<typeof drizzle>;
    const { eq } = await import("drizzle-orm");
    await db.update(settings).set({ value: { name: "Northwind", poweredBy: true, hasLogo: false } }).where(eq(settings.key, "branding"));
    expect(await readBrand()).toMatchObject({ name: "Northwind", hasLogo: false, logoVersion: null });
  });
});

// Final review 1.8.3 M1 and M2: the backfill wrote back the whole row it read earlier, so a save in between (a new
// name, a new logo and its version) was undone; and a brand whose logo row is gone paid an extra read on every render.
describe("the logo version backfill (final review 1.8.3)", () => {
  it("adds only the version, and never over a version a newer save wrote", async () => {
    const db = h.db as ReturnType<typeof drizzle>;
    const { eq } = await import("drizzle-orm");
    await db.update(settings).set({ value: { name: "New name", poweredBy: true, hasLogo: true } }).where(eq(settings.key, "branding"));
    await db.update(settings).set({ value: { png: Buffer.from(PNG).toString("base64") } }).where(eq(settings.key, "branding.logo"));
    await fillLogoVersion({ name: "Old name", accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: true, logoVersion: null });
    let [row] = await db.select().from(settings).where(eq(settings.key, "branding"));
    expect(row.value).toMatchObject({ name: "New name", logoVersion: logoVersionOf(PNG) });
    await db.update(settings).set({ value: { name: "New name", poweredBy: true, hasLogo: true, logoVersion: "aaaaaaaaaaaa" } }).where(eq(settings.key, "branding"));
    await fillLogoVersion({ name: "New name", accent: null, senderName: null, publicUrl: null, poweredBy: true, hasLogo: true, logoVersion: null });
    [row] = await db.select().from(settings).where(eq(settings.key, "branding"));
    expect((row.value as { logoVersion: string }).logoVersion).toBe("aaaaaaaaaaaa");
  });

  it("a brand whose logo row is gone stops claiming a logo", async () => {
    const db = h.db as ReturnType<typeof drizzle>;
    const { eq } = await import("drizzle-orm");
    await db.update(settings).set({ value: { name: "Kopi", poweredBy: true, hasLogo: true } }).where(eq(settings.key, "branding"));
    await db.delete(settings).where(eq(settings.key, "branding.logo"));
    expect(await readBrand()).toMatchObject({ name: "Kopi", hasLogo: false, logoVersion: null });
    const [row] = await db.select().from(settings).where(eq(settings.key, "branding"));
    expect((row.value as { hasLogo: boolean }).hasLogo).toBe(false);
  });
});
