"use client";

import { useActionState, useRef } from "react";
import { Button, Field, fieldClass } from "@/components/kit";
import { PUBLISHED_DEMO_EMAIL, PUBLISHED_DEMO_PASSWORD } from "@/lib/demo/account";
import type { PasswordSignInState } from "@/lib/local-auth/signin";
import { signInWithPassword } from "./actions";

// Demo sign-in: the published account (one click fills the form) or any email and password. Every sign-in gets a new
// made-up dataset of its own.
export function DemoSignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<PasswordSignInState, FormData>(signInWithPassword, { status: "idle" });
  const email = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const fillDemoAccount = () => {
    if (email.current) email.current.value = PUBLISHED_DEMO_EMAIL;
    if (password.current) password.current.value = PUBLISHED_DEMO_PASSWORD;
    password.current?.focus();
  };
  return (
    <form action={action}>
      <h1 className="mb-1 text-xl">Try the Watchbell demo</h1>
      <p className="mb-[18px] text-ink-soft">Sign in with the demo account to look around a console full of made-up data of your own.</p>
      <div className="mb-[18px] rounded-lg border border-line bg-sunken px-3.5 py-3">
        <dl className="mb-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-ink-soft">Email</dt>
          <dd className="break-all font-mono">{PUBLISHED_DEMO_EMAIL}</dd>
          <dt className="text-ink-soft">Password</dt>
          <dd className="font-mono">{PUBLISHED_DEMO_PASSWORD}</dd>
        </dl>
        <Button size="sm" onClick={fillDemoAccount}>Use demo account</Button>
      </div>
      {next && <input type="hidden" name="next" value={next} />}
      <Field id="email" label="Email" error={state.status === "error" && state.field === "email" ? state.message : undefined}>
        <input ref={email} id="email" name="email" type="email" autoComplete="username" placeholder="name@example.com" required maxLength={254} defaultValue={state.status === "error" ? state.email : undefined} className={fieldClass} />
      </Field>
      <Field id="password" label="Password" error={state.status === "error" && state.field !== "email" ? state.message : undefined}>
        <input ref={password} id="password" name="password" type="password" autoComplete="current-password" required maxLength={200} className={fieldClass} />
      </Field>
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="mt-4 text-[12.5px] text-ink-faint">Or use any email and password. Every sign-in, the demo account too, gets its own made-up data.</p>
    </form>
  );
}
