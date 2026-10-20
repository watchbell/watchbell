import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/kit";
import { currentMfa } from "@/lib/auth";
import { ChallengeForm } from "./challenge-form";

export default async function MfaPage() {
  const { step } = await currentMfa();
  if (step === "ok") redirect("/");
  if (step === "setup") redirect("/mfa/setup");
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[400px] max-w-full rounded-xl border border-line bg-surface p-7">
        <span className="mb-[18px] grid size-7 place-items-center rounded-[7px] bg-brand font-mono text-xs font-semibold text-on-brand">WB</span>
        <h1 className="mb-1 text-xl">Enter your code</h1>
        <p className="mb-[18px] text-ink-soft">Open your authenticator app and type the 6-digit code for Watchbell.</p>
        <ChallengeForm />
        <form action={signOut} className="mt-3"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
      </div>
    </main>
  );
}
