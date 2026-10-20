"use client";

import { useActionState, useState, useTransition } from "react";
import { Banner, Button, Field, fieldClass } from "@/components/kit";
import { confirmMfaEnrollment, type Enrollment, type MfaFormState, startMfaEnrollment } from "../actions";
import { useReloadWhenDone } from "../use-reload-when-done";

export function SetupFlow() {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [starting, start] = useTransition();
  const [state, action, pending] = useActionState<MfaFormState, FormData>(confirmMfaEnrollment, { status: "idle" });
  useReloadWhenDone(state);
  const done = state.status === "done";

  if (!enrollment || !enrollment.ok) {
    return (
      <>
        {enrollment && !enrollment.ok && <div className="mb-3"><Banner tone="danger" title={enrollment.error} /></div>}
        <Button variant="primary" className="w-full justify-center" disabled={starting} onClick={() => start(async () => setEnrollment(await startMfaEnrollment()))}>
          {starting ? "Preparing…" : "Set up authenticator"}
        </Button>
      </>
    );
  }

  return (
    <form action={action}>
      <ol className="mb-3 list-decimal pl-5 text-[13px] text-ink-soft">
        <li>Scan this QR code with your authenticator app.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL SVG (Supabase in the cloud, rendered on the server in self-host) */}
      <img src={enrollment.qr} alt="QR code for your authenticator app" className="mx-auto mb-3 size-44 rounded-lg bg-white p-2" />
      <p className="mb-3 text-center text-[12.5px] text-ink-soft">Can&apos;t scan? Enter this key: <code className="font-mono break-all text-ink">{enrollment.secret}</code></p>
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <Field id="code" label="Code" error={state.status === "error" ? state.message : undefined}>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className={`${fieldClass} font-mono tracking-widest`} placeholder="123456" />
      </Field>
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending || done}>{done ? "Opening the console…" : pending ? "Checking…" : "Turn on"}</Button>
    </form>
  );
}
