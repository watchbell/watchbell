"use client";

import { useActionState } from "react";
import { Button, Field, fieldClass } from "@/components/kit";
import type { PasswordSignInState } from "@/lib/local-auth/signin";
import { signInWithPassword } from "./actions";

// Self-host sign-in: email and password, no email link and no bot check (the console has no mail service).
export function PasswordSignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<PasswordSignInState, FormData>(signInWithPassword, { status: "idle" });
  return (
    <form action={action}>
      <h1 className="mb-1 text-xl">Sign in to Watchbell</h1>
      <p className="mb-[18px] text-ink-soft">Use the email and password an owner set up for you.</p>
      {next && <input type="hidden" name="next" value={next} />}
      <Field id="email" label="Email">
        <input id="email" name="email" type="email" autoComplete="username" placeholder="name@example.com" required defaultValue={state.status === "error" ? state.email : undefined} className={fieldClass} />
      </Field>
      <Field id="password" label="Password" error={state.status === "error" ? state.message : undefined}>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} className={fieldClass} />
      </Field>
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="mt-4 text-[12.5px] text-ink-faint">Forgot your password? Ask an owner of this console.</p>
    </form>
  );
}
