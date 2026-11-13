import { readBrandLogo } from "@/lib/data/branding-db";

// Watchbell 1.7 (spec §7): the brand's logo (a checked PNG, Settings › Branding) for the sign-in page, the sidebar, the
// browser tab and the public status page. Public like those pages; it holds nothing but the picture the owner chose.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const logo = await readBrandLogo().catch(() => null);
  if (!logo) return new Response("No logo.", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(logo as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
}
