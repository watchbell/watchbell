"use client";

import { useActionState } from "react";
import { Button, Field, fieldClass } from "@/components/kit";
import { type SetupFormState, submitSetup } from "./actions";

export function SetupForm() {
  const [state, action, pending] = useActionState<SetupFormState, FormData>(submitSetup, { status: "idle" });
  const errorFor = (field: string) => (state.status === "error" && state.field === field ? state.message : undefined);
  const typed = state.status === "error" ? state : { code: "", email: "" };
  const general = state.status === "error" && !state.field ? state.message : undefined;
  return (
    // keyed by the state so a refused submit refills the code and email (a form action resets the form)
    <form action={action} key={state.status === "error" ? `${state.message}:${typed.code}:${typed.email}` : "idle"}>
      <Field id="code" label="Setup code" error={errorFor("code")}>
        <input id="code" name="code" autoComplete="off" spellCheck={false} defaultValue={typed.code} placeholder="XXXXX-XXXXX" maxLength={20} required className={`${fieldClass} font-mono uppercase tracking-widest`} />
      </Field>
      <Field id="email" label="Email" error={errorFor("email")}>
        <input id="email" name="email" type="email" defaultValue={typed.email} autoComplete="email" placeholder="name@example.com" required className={fieldClass} />
      </Field>
      <Field id="password" label="Password" help="At least 12 characters." error={errorFor("password")}>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required className={fieldClass} />
      </Field>
      <Field id="confirm" label="Confirm password" error={errorFor("confirm")}>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={200} required className={fieldClass} />
      </Field>
      {general && <p className="mb-3.5 text-[12.5px] text-err" role="alert">{general}</p>}
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending}>
        {pending ? "Creating…" : "Create owner account"}
      </Button>
      <p className="mt-4 text-[12.5px] text-ink-faint">Next you&apos;ll add an authenticator app. Owners always sign in with a code.</p>
    </form>
  );
}
