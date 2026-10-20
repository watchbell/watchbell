"use client";

import { useActionState, useState } from "react";
import { Button, Field, fieldClass } from "@/components/kit";
import { Turnstile } from "@/components/turnstile";
import type { SignInState } from "@/lib/signin";
import { sendSignInLink } from "./actions";

export function SignInForm({ siteKey }: { siteKey: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(sendSignInLink, { status: "idle" });
  const [again, setAgain] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (state.status === "sent" && !again) {
    return (
      <>
        <h1 className="mb-1 text-xl">Check your email</h1>
        <p className="mb-[18px] text-ink-soft">If {state.email} is invited, a sign-in link is on its way. It works for 1 hour.</p>
        <Button className="w-full justify-center" onClick={() => setAgain(true)}>Use a different email</Button>
      </>
    );
  }

  return (
    <form action={(fd) => { setAgain(false); setAttempt((a) => a + 1); action(fd); }}>
      <h1 className="mb-1 text-xl">Sign in to Watchbell</h1>
      <p className="mb-[18px] text-ink-soft">We&apos;ll email you a sign-in link. Only invited people can get in.</p>
      <Field id="email" label="Email" error={state.status === "error" ? state.message : undefined}>
        <input id="email" name="email" type="email" autoComplete="email" placeholder="name@example.com" required className={fieldClass} />
      </Field>
      <Turnstile key={attempt} siteKey={siteKey} />
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending}>
        {pending ? "Sending…" : "Send sign-in link"}
      </Button>
      <p className="mt-4 text-[12.5px] text-ink-faint">Can&apos;t get in? Ask an owner to invite you.</p>
    </form>
  );
}
