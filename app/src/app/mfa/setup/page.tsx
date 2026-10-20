import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/kit";
import { currentMfa } from "@/lib/auth";
import { SetupFlow } from "./setup-flow";

export default async function MfaSetupPage() {
  const { member, step } = await currentMfa();
  if (step === "ok") redirect("/");
  if (step === "challenge") redirect("/mfa");
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[440px] max-w-full rounded-xl border border-line bg-surface p-7">
        <span className="mb-[18px] grid size-7 place-items-center rounded-[7px] bg-brand font-mono text-xs font-semibold text-on-brand">WB</span>
        <h1 className="mb-1 text-xl">Protect your account</h1>
        <p className="mb-[18px] text-ink-soft">{member.role === "owner" ? "Owners" : "Operators"} can change your infrastructure, so the console asks for a code from an authenticator app (Google Authenticator, 1Password, Authy) every time you sign in.</p>
        <SetupFlow />
        <form action={signOut} className="mt-3"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
      </div>
    </main>
  );
}
