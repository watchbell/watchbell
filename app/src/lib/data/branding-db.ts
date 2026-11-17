import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { BRAND_SETTING, type Brand, DEFAULT_BRAND, parseBrand } from "@/lib/branding";
import { logoVersionOf } from "@/lib/branding-version";
import { ttlMemo } from "@/lib/memo";
import { isDemo } from "@/lib/mode";

// Watchbell 1.7: the brand (one small ops.settings row, read by the layout on each render) and its logo (a separate
// row, read only by the icon route, the PDF and emails).
const LOGO_SETTING = "branding.logo";

export async function readBrand(): Promise<Brand> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, BRAND_SETTING)).limit(1);
  const b = row ? parseBrand(row.value) : { ...DEFAULT_BRAND };
  return b.hasLogo && !b.logoVersion ? fillLogoVersion(b) : b;
}

// 1.8.3 (1.7.1 note): a logo uploaded with 1.7.0 has no version, so its pages asked for a bare /brand-icon the CDN
// keeps 5 minutes. The first read computes it from the stored logo and saves it (a failed save is tried again on the
// next read; the brand is shown either way). Final review M1/M2: only the version key is added, and only while the
// row still has none, so a save made meanwhile (a new name, a new logo with its version) is never undone; a brand
// whose logo row is gone stops claiming a logo, so it doesn't pay this read on every render.
const NO_VERSION = sql`(${settings.value} ->> 'logoVersion') is null`;
export async function fillLogoVersion(b: Brand): Promise<Brand> {
  let png: Uint8Array | null;
  try {
    png = await readBrandLogo();
  } catch {
    return b; // can't tell; nothing written
  }
  const patch = png ? sql`jsonb_build_object('logoVersion', ${logoVersionOf(png)}::text)` : sql`'{"hasLogo": false}'::jsonb`;
  await db().update(settings).set({ value: sql`${settings.value} || ${patch}`, updatedAt: new Date() })
    .where(and(eq(settings.key, BRAND_SETTING), NO_VERSION)).catch(() => undefined);
  return png ? { ...b, logoVersion: logoVersionOf(png) } : { ...b, hasLogo: false };
}

// 1.8.1 (public routes audit): the sign-in page, the logo and the public status page are open to anyone, so they read
// the brand and the logo through a per-instance memo (one read a minute per instance, however many requests). The
// writers below clear it; other instances catch up within the minute.
export const PUBLIC_BRAND_TTL_MS = 60_000;
// Not in the demo, where each visitor's database is their own (final review I2).
export const publicBrand = ttlMemo(() => readBrand(), PUBLIC_BRAND_TTL_MS, Date.now, () => isDemo());
export const publicBrandLogo = ttlMemo(() => readBrandLogo(), PUBLIC_BRAND_TTL_MS, Date.now, () => isDemo());

// The logo is kept as it is (hasLogo and its version are written with it, never by the form).
export async function saveBrand(b: Brand): Promise<void> {
  const current = await readBrand();
  const value = { ...b, hasLogo: current.hasLogo, logoVersion: current.logoVersion };
  await db().insert(settings).values({ key: BRAND_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  publicBrand.clear();
}

export async function readBrandLogo(): Promise<Uint8Array | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, LOGO_SETTING)).limit(1);
  const png = (row?.value as { png?: unknown } | undefined)?.png;
  return typeof png === "string" ? new Uint8Array(Buffer.from(png, "base64")) : null;
}

// null removes the logo. The brand row's hasLogo follows.
export async function saveBrandLogo(bytes: Uint8Array | null): Promise<void> {
  const now = new Date();
  if (bytes) {
    const value = { png: Buffer.from(bytes).toString("base64") };
    await db().insert(settings).values({ key: LOGO_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  } else {
    await db().delete(settings).where(inArray(settings.key, [LOGO_SETTING]));
  }
  const b = await readBrand();
  const value = { ...b, hasLogo: bytes !== null, logoVersion: bytes ? logoVersionOf(bytes) : null };
  await db().insert(settings).values({ key: BRAND_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  publicBrand.clear();
  publicBrandLogo.clear();
}
