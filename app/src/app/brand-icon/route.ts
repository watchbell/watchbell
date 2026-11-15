import { logoVersionOf } from "@/lib/branding-version";
import { readBrandLogo } from "@/lib/data/branding-db";

// Watchbell 1.7 (spec §7): the brand's logo (a checked PNG, Settings › Branding) for the sign-in page, the sidebar, the
// browser tab and the public status page. Public like those pages; it holds nothing but the picture the owner chose.
export const dynamic = "force-dynamic";

// Review M-9 (1.7.1): pages ask for /brand-icon?v=<logo version>; that address is cached at the CDN for good (a new logo
// gets a new one), so the function and its database read run once per logo, not once per page view. An address without
// a version (a page cached before 1.7.1) is kept 5 minutes.
export async function GET(req: Request): Promise<Response> {
  const logo = await readBrandLogo().catch(() => null);
  if (!logo) return new Response("No logo.", { status: 404, headers: { "cache-control": "no-store" } });
  // Final review: only the address of this very logo is kept for good; any other version gets the short cache.
  const versioned = new URL(req.url).searchParams.get("v") === logoVersionOf(logo);
  const cache = versioned ? "public, max-age=86400, s-maxage=31536000, immutable" : "public, max-age=300, s-maxage=300";
  return new Response(logo as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "image/png", "cache-control": cache, "x-content-type-options": "nosniff" } });
}
