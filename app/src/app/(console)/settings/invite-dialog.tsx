"use client";

import { IconUserPlus } from "@tabler/icons-react";
import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Button, Field, fieldClass } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action";
import { inviteUser } from "./actions";

const ROLES = [
  ["owner", "Owner", "Everything, including connections, users, and settings"],
  ["operator", "Operator", "Sees everything and can redeploy, restore, wake, and silence alerts"],
  ["viewer", "Viewer", "Read-only. No logs and no actions"],
] as const;

// The form lives in its own component so it unmounts when the dialog closes. That clears the
// field errors from an earlier attempt, and lets the result be handled inside the action itself
// instead of in an effect (the lint rules forbid setState in effect bodies).
function InviteForm({ onDone }: { onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(async (prev, formData) => {
    const result = await inviteUser(prev, formData);
    if (result.ok) {
      toast.success(result.message ?? "Invite saved.");
      onDone();
    } else if (!result.fieldErrors) {
      toast.error(result.error);
    }
    return result;
  }, null);

  const errors = state && !state.ok ? state.fieldErrors ?? {} : {};

  return (
    <form action={action}>
      <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconUserPlus size={19} /></span>
        <div>
          <DialogTitle className="text-base">Invite user</DialogTitle>
          <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">They sign in at the console&apos;s sign-in page with this email. The invite lasts 7 days.</DialogDescription>
        </div>
      </div>
      <div className="px-[18px] pt-1.5">
        <Field id="inv-email" label="Email" error={errors.email}>
          <input id="inv-email" name="email" type="email" placeholder="name@example.com" className={fieldClass} />
        </Field>
        <fieldset className="mb-3.5">
          <legend className="mb-[5px] text-[13px] font-medium">Role</legend>
          <div className="overflow-hidden rounded-lg border border-line">
            {ROLES.map(([value, label, desc]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2.5 border-t border-line px-3 py-[9px] first:border-t-0 hover:bg-hover">
                <input type="radio" name="role" value={value} defaultChecked={value === "viewer"} className="mt-[3px] accent-brand" />
                <span>{label}<small className="block text-xs text-ink-faint">{desc}</small></span>
              </label>
            ))}
          </div>
          {errors.role && <span className="text-[12.5px] text-err" role="alert">{errors.role}</span>}
        </fieldset>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button onClick={onDone} disabled={pending}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save invite"}</Button>
      </div>
    </form>
  );
}

export function InviteDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="primary" size="sm" className="ml-auto" />}>Invite user</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        <InviteForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
