import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { AuthError } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { finishDriveConnect } from "@/lib/backup/callback";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH } from "@/lib/backup/connect";
import { driveEnv } from "@/lib/backup/google-oauth";
import { recordAction } from "@/lib/data/audit-db";
import { saveDriveAccount } from "@/lib/data/backup-db";
import { serverEnv } from "@/lib/env";

// B1: Google sends the owner back here after the consent screen. /auth/ is a public prefix (lib/paths.ts), so this
// handler checks the session itself: the same Owner (aal2) who started the connect, proven by the sealed ticket cookie.
// Every answer is a redirect to /backups with a fixed code; the ticket cookie is cleared whatever happens.
export async function GET(request: NextRequest) {
  const site = serverEnv().SITE_URL;
  const back = (code: string) => {
    const res = NextResponse.redirect(new URL(`/backups?drive=${code}`, site), { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: "lax", secure: site.startsWith("https://") });
    return res;
  };
  let member;
  try {
    member = await requireActionMember("owner");
  } catch (e) {
    const reason = e instanceof AuthError ? e.reason : "signed-out";
    if (reason === "signed-out") return NextResponse.redirect(new URL("/signin?next=%2Fbackups", site));
    return back("member");
  }
  const jar = await cookies();
  const params = request.nextUrl.searchParams;
  const key = serverEnv().OPS_ENCRYPTION_KEY;
  const code = await finishDriveConnect(
    { cookie: jar.get(OAUTH_COOKIE)?.value, state: params.get("state"), code: params.get("code"), error: params.get("error"), memberId: member.id },
    {
      env: driveEnv(), keyB64: key, siteUrl: site, save: saveDriveAccount,
      audit: (e) => recordAction({ ...e, resourceId: null, actorUserId: member.userId }),
    },
  ).catch(() => "failed" as const);
  return back(code);
}
