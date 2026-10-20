import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/kit";
import { currentMfa, getSessionUser } from "@/lib/auth";
import { mode } from "@/lib/mode";
import { ChangePasswordForm } from "./password-form";

// Self-host only: change your own password. Members added by an owner land here (after the MFA step) until they replace
// the temporary password; the console's gates send them back here until then.
export default async function AccountPasswordPage() {
  // Rendered per request: the mode is read at run time (a build made without WATCHBELL_MODE must not bake in the 404).
  await connection();
  if (mode() !== "selfhost") notFound();
  const { member, step } = await currentMfa();
  if (step === "setup") redirect("/mfa/setup");
  if (step === "challenge") redirect("/mfa");
  // Cached for this render: the session currentMfa() just read, no second query.
  const forced = (await getSessionUser())?.mustChangePassword === true;
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[400px] max-w-full rounded-xl border border-line bg-surface p-7">
        <span className="mb-[18px] grid size-7 place-items-center rounded-[7px] bg-brand font-mono text-xs font-semibold text-on-brand">WB</span>
        <h1 className="mb-1 text-xl">{forced ? "Choose your password" : "Change password"}</h1>
        <p className="mb-[18px] text-ink-soft">
          {forced ? "You signed in with a temporary password. Pick your own before you use the console." : `Signed in as ${member.email}.`}
        </p>
        <ChangePasswordForm forced={forced} />
        {forced ? (
          <form action={signOut} className="mt-3"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
        ) : (
          <Link href="/" className="mt-3 inline-block text-[13px] text-ink-soft hover:text-ink">Back to the console</Link>
        )}
      </div>
    </main>
  );
}
