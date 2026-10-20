"use client";

import { useActionState } from "react";
import { Button, Field, fieldClass } from "@/components/kit";
import { changePassword, type PasswordFormState } from "./actions";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, action, pending] = useActionState<PasswordFormState, FormData>(changePassword, { status: "idle" });
  const errorFor = (field: string) => (state.status === "error" && state.field === field ? state.message : undefined);
  const general = state.status === "error" && !state.field ? state.message : undefined;
  return (
    <form action={action}>
      <Field id="current" label={forced ? "Temporary password" : "Current password"} error={errorFor("current")}>
        <input id="current" name="current" type="password" autoComplete="current-password" required maxLength={1024} className={fieldClass} />
      </Field>
      <Field id="password" label="New password" help="At least 12 characters." error={errorFor("password")}>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required className={fieldClass} />
      </Field>
      <Field id="confirm" label="Confirm new password" error={errorFor("confirm")}>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={200} required className={fieldClass} />
      </Field>
      {general && <p className="mb-3.5 text-[12.5px] text-err" role="alert">{general}</p>}
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
      <p className="mt-4 text-[12.5px] text-ink-faint">Your other devices are signed out when the password changes.</p>
    </form>
  );
}
