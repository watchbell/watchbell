import { BellMark } from "@/components/brand/bell-mark";
import { Banner } from "@/components/kit";
import { serverEnv } from "@/lib/env";
import { isDemo, usesLocalAuth } from "@/lib/mode";
import { DemoSignInForm } from "./demo-form";
import { PasswordSignInForm } from "./password-form";
import { SignInForm } from "./signin-form";

const ERRORS: Record<string, string> = {
  link: "That link is invalid or has expired. Send a new one.",
  "not-member": "That email isn't on this console. Ask an owner to invite you.",
  "session-ended": "Your session ended. Sign in again.",
};

// Self-host has no invites by email: an owner adds people on the console.
const SELFHOST_ERRORS: Record<string, string> = {
  ...ERRORS,
  "not-member": "That account isn't on this console. Ask an owner to add you.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const selfhost = usesLocalAuth();
  const errors = selfhost ? SELFHOST_ERRORS : ERRORS;
  const nextPath = typeof next === "string" ? next : undefined;
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[400px] max-w-full rounded-xl border border-line bg-surface p-7">
        <BellMark className="mb-[18px]" />
        {error && errors[error] && <div className="mb-4"><Banner tone="warning" title={errors[error]} /></div>}
        {isDemo() ? (
          <DemoSignInForm next={nextPath} />
        ) : selfhost ? (
          <PasswordSignInForm next={nextPath} />
        ) : (
          <SignInForm siteKey={serverEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
        )}
      </div>
    </main>
  );
}
