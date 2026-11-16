import "server-only";
import { eq, inArray } from "drizzle-orm";
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
  return row ? parseBrand(row.value) : { ...DEFAULT_BRAND };
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
