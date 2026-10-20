"use client";

import { useActionState } from "react";
import { Button, Field, fieldClass } from "@/components/kit";
import { type MfaFormState, verifyMfaCode } from "./actions";
import { useReloadWhenDone } from "./use-reload-when-done";

export function ChallengeForm() {
  const [state, action, pending] = useActionState<MfaFormState, FormData>(verifyMfaCode, { status: "idle" });
  useReloadWhenDone(state);
  const done = state.status === "done";
  return (
    <form action={action}>
      <Field id="code" label="Code" error={state.status === "error" ? state.message : undefined}>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className={`${fieldClass} font-mono tracking-widest`} placeholder="123456" />
      </Field>
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending || done}>{done ? "Opening the console…" : pending ? "Checking…" : "Verify"}</Button>
    </form>
  );
}
