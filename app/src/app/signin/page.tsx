import { BrandMark } from "@/components/brand/brand-mark";
import { brandStyle, DEFAULT_BRAND, displayName } from "@/lib/branding";
import { readBrand } from "@/lib/data/branding-db";
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
  // Watchbell 1.7: the owner's brand (Settings › Branding); without one the page is as before.
  const brand = await readBrand().catch(() => DEFAULT_BRAND);
  const style = brandStyle(brand);
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[400px] max-w-full rounded-xl border border-line bg-surface p-7">
        {style && <style>{style}</style>}
        <BrandMark name={displayName(brand)} hasLogo={brand.hasLogo} className="mb-[18px]" />
        {error && errors[error] && <div className="mb-4"><Banner tone="warning" title={errors[error]} /></div>}
        {isDemo() ? (
          <DemoSignInForm next={nextPath} />
        ) : selfhost ? (
          <PasswordSignInForm next={nextPath} appName={displayName(brand)} />
        ) : (
          <SignInForm siteKey={serverEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY} appName={displayName(brand)} />
        )}
        {brand.name && brand.poweredBy && <p className="mt-5 mb-0 text-center text-[11.5px] text-ink-faint">Powered by Watchbell</p>}
      </div>
    </main>
  );
}
