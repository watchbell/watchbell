"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kit";
import { roleChangeCopy } from "@/lib/members";
import type { Role } from "@/lib/roles";
import { changeRole, removeMember, revokeInvite } from "./actions";

const asResult = (r: { ok: boolean; message?: string; error?: string }) => ({ ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" });

// Picking a role only stages it. Nothing changes until the owner confirms, so a stray click or a
// scroll over the select can't hand someone the keys.
export function RoleSelect({ memberId, email, role }: { memberId: string; email: string; role: Role }) {
  const [staged, setStaged] = useState<Role>(role);
  const changed = staged !== role;
  const copy = roleChangeCopy(email, role, staged);
  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Role for ${email}`}
        value={staged}
        className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px]"
        onChange={(e) => setStaged(e.target.value as Role)}
      >
        <option value="owner">Owner</option>
        <option value="operator">Operator</option>
        <option value="viewer">Viewer</option>
      </select>
      {changed && (
        <>
          <ConfirmDialog
            trigger={<Button size="sm" variant="primary">Save</Button>}
            title={copy.title}
            body={copy.body}
            cta={copy.cta}
            danger={copy.danger}
            onConfirm={async () => asResult(await changeRole(memberId, staged))}
          />
          <Button size="sm" variant="ghost" onClick={() => setStaged(role)}>Cancel</Button>
        </>
      )}
    </div>
  );
}

// deletesAccount: self-host, where removing a member also deletes their account and signs them out everywhere.
export function RemoveMember({ memberId, email, deletesAccount = false }: { memberId: string; email: string; deletesAccount?: boolean }) {
  return (
    <ConfirmDialog
      trigger={<Button size="sm">Remove</Button>}
      title={`Remove ${email}?`}
      body={deletesAccount ? "They lose access right away. Their account and sessions are deleted." : "They lose access right away. Nothing else changes."}
      cta="Remove"
      danger
      onConfirm={async () => asResult(await removeMember(memberId))}
    />
  );
}

export function RevokeInvite({ inviteId, email }: { inviteId: string; email: string }) {
  return (
    <ConfirmDialog
      trigger={<Button size="sm">Withdraw</Button>}
      title={`Withdraw the invite for ${email}?`}
      body="They can no longer join with the email they received."
      cta="Withdraw"
      danger
      onConfirm={async () => asResult(await revokeInvite(inviteId))}
    />
  );
}
