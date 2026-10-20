import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { AuthError } from "@/lib/action";
import { getSessionUser, requireActionMember } from "@/lib/auth";
import { driveEnv } from "@/lib/backup/google-oauth";
import { finishCreateConnect } from "@/lib/create/google-callback";
import { CREATE_COOKIE, CREATE_COOKIE_PATH } from "@/lib/create/google-connect";
import { recordAction } from "@/lib/data/audit-db";
import { saveCreateGrant } from "@/lib/data/create-db";
import { serverEnv } from "@/lib/env";

// Stage 6 create requests, Firebase: Google sends the Owner back here after the "Connect Google (create projects)"
// consent. /auth/ is a public prefix (lib/paths.ts), so this handler checks the session itself: the same Owner, with an
// aal2 session, who started the connect (the sealed ticket cookie). Every answer is a redirect to /firebase with a fixed
// code; the ticket cookie is cleared whatever happens. The owner adds this redirect URI to the OAuth client once.
export async function GET(request: NextRequest) {
  const site = serverEnv().SITE_URL;
  const back = (code: string) => {
    const res = NextResponse.redirect(new URL(`/firebase?google=${code}`, site), { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(CREATE_COOKIE, "", { path: CREATE_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: "lax", secure: site.startsWith("https://") });
    return res;
  };
  let member;
  try {
    member = await requireActionMember("owner");
    if ((await getSessionUser())?.aal !== "aal2") return back("member");
  } catch (e) {
    const reason = e instanceof AuthError ? e.reason : "signed-out";
    if (reason === "signed-out") return NextResponse.redirect(new URL("/signin?next=%2Ffirebase", site));
    return back("member");
  }
  const jar = await cookies();
  const params = request.nextUrl.searchParams;
  const code = await finishCreateConnect(
    { cookie: jar.get(CREATE_COOKIE)?.value, state: params.get("state"), code: params.get("code"), error: params.get("error"), memberId: member.id },
    {
      env: driveEnv(), keyB64: serverEnv().OPS_ENCRYPTION_KEY, siteUrl: site, save: saveCreateGrant,
      audit: (e) => recordAction({ ...e, resourceId: null, actorUserId: member.userId }),
    },
  ).catch(() => "failed" as const);
  return back(code);
}
