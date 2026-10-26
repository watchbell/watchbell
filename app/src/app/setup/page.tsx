import { BellMark } from "@/components/brand/bell-mark";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ownerExists } from "@/lib/local-auth/setup";
import { mode } from "@/lib/mode";
import { SetupForm } from "./setup-form";

// Self-host first run only. Cloud, and any install that already has an owner, answer 404.
export default async function SetupPage() {
  await connection();
  if (mode() !== "selfhost" || (await ownerExists())) notFound();
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[400px] max-w-full rounded-xl border border-line bg-surface p-7">
        <BellMark className="mb-[18px]" />
        <h1 className="mb-1 text-xl">Set up Watchbell</h1>
        <p className="mb-[18px] text-ink-soft">Create the owner account. The setup code is on the screen where you started Watchbell (watchbell start prints it) and in its log file. It is valid for 24 hours.</p>
        <SetupForm />
      </div>
    </main>
  );
}
