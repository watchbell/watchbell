import { redirect } from "next/navigation";
import { authProvider } from "@/lib/auth-provider";

// A signed-in user who isn't a member lands here. Local scope (Watchbell 1.2.1, audit L4): a link from any site is a
// top-level GET that carries the SameSite=Lax cookies, so a global sign-out here would let a crafted link end every
// session the owner has. A non-member gains nothing from a global sign-out either.
export async function GET() {
  await authProvider().signOut("local");
  redirect("/signin?error=not-member");
}
