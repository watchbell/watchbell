"use client";

import { IconUserPlus } from "@tabler/icons-react";
import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Button, Field, fieldClass } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action";
import { type AddedMember, addMember } from "./actions";

const ROLES = [
  ["owner", "Owner", "Everything, including connections, users, and settings"],
  ["operator", "Operator", "Sees everything and can redeploy, restore, wake, and silence alerts"],
  ["viewer", "Viewer", "Read-only. No logs and no actions"],
] as const;

// Self-host counterpart of InviteDialog. The temporary password lives only in this component's state: closing the dialog
// unmounts it, and the server keeps nothing but its hash, so it is shown exactly once.
function TemporaryPassword({ added, onDone }: { added: AddedMember; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(added.password);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the password and copy it yourself.");
    }
  };
  return (
    <>
      <div className="px-[18px] pb-2 pt-4">
        <DialogTitle className="text-base">{added.email} was added</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
          Share this temporary password with them privately (not in a group chat or a ticket). It is shown only now and
          works for 7 days; they choose their own at their first sign-in.
        </DialogDescription>
      </div>
      <div className="px-[18px] pb-3.5 pt-1.5">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <code className="flex-1 select-all break-all font-mono text-[14px] tracking-wide" aria-label="Temporary password">{added.password}</code>
          <Button size="sm" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </>
  );
}

function AddMemberForm({ onDone }: { onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionResult<AddedMember> | null, FormData>(async (prev, formData) => {
    const result = await addMember(prev, formData);
    if (!result.ok && !result.fieldErrors) toast.error(result.error);
    return result;
  }, null);

  if (state?.ok && state.data) return <TemporaryPassword added={state.data} onDone={onDone} />;
  const errors = state && !state.ok ? state.fieldErrors ?? {} : {};

  return (
    <form action={action}>
      <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconUserPlus size={19} /></span>
        <div>
          <DialogTitle className="text-base">Add member</DialogTitle>
          <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">This creates their account with a temporary password, shown once on the next screen.</DialogDescription>
        </div>
      </div>
      <div className="px-[18px] pt-1.5">
        <Field id="add-email" label="Email" error={errors.email}>
          <input id="add-email" name="email" type="email" placeholder="name@example.com" className={fieldClass} />
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
        <Button type="submit" variant="primary" disabled={pending}>{pending ? "Adding…" : "Add member"}</Button>
      </div>
    </form>
  );
}

export function AddMemberDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="primary" size="sm" className="ml-auto" />}>Add member</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        <AddMemberForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
