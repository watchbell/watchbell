import { NextResponse } from "next/server";
import { AuthError } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { listWorkspaces } from "@/lib/data/workspace-db";
import { WS_COOKIE, wsCookieOptions } from "@/lib/workspace/choice";

// Watchbell 1.8: the palette's "Go to workspace" link. Sets the workspace cookie (a page render can't) and opens
// Overview. Any member; it changes only what this browser shows.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    await requireActionMember("viewer");
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.redirect(new URL("/signin", url), 303);
    throw e;
  }
  const id = url.searchParams.get("id") ?? "";
  if (!(await listWorkspaces()).some((w) => w.id === id)) return new Response("No such workspace.", { status: 404, headers: { "cache-control": "no-store" } });
  const res = NextResponse.redirect(new URL("/", url), 303);
  res.cookies.set(WS_COOKIE, id, wsCookieOptions());
  res.headers.set("cache-control", "no-store");
  return res;
}
