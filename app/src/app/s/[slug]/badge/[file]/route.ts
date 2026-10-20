import { publicBadge } from "@/lib/data/public-status-db";
import { badgeSvg, parseSlug } from "@/lib/public-status";

// U7: /s/{slug}/badge/{key}.svg, rendered on first request and cached 5 minutes (ISR). `.svg` paths skip the proxy
// (src/proxy.ts matcher), so no session work; nothing here reads cookies or headers, or it would turn dynamic.
export const revalidate = 300;
export const dynamic = "force-static";
export async function generateStaticParams() {
  return [];
}

const KEY = /^([a-z0-9-]{1,40})\.svg$/;
const HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  // Opened on its own, the SVG may not load or run anything.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; file: string }> }) {
  const { slug: rawSlug, file } = await ctx.params;
  const slug = parseSlug(rawSlug);
  const key = KEY.exec(file)?.[1];
  const b = slug && key ? await publicBadge(slug, key, new Date()) : null;
  const svg = b ? badgeSvg(b.label, b.value, b.tone) : badgeSvg("status", "not found", "unknown");
  return new Response(svg, { status: b ? 200 : 404, headers: HEADERS });
}
