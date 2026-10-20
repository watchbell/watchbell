"use client";

import { IconPlayerPlay } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Masked, useMask } from "@/components/alias";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { useProviderAction } from "@/components/provider-action";
import { RowMenu } from "@/components/row-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/action";
import { pauseAction, restoreAction, setAutoRestore, setKeepActive } from "./actions";
import { MetricsKeyDialog } from "./metrics-key-dialog";

// Stage 6 Supabase row controls (mockup supabase(), restoreDlg(), confirmFor()). Database names are always shown by
// their alias (privacy), so the dialogs and toasts use it and the server's message (which has the real name) is only
// used for failures.

export type PauseChoice = { id: string; ref: string; alias: string; traffic: string; usedBy: string[] };

const PAUSE_BODY = "Supabase stops the project in about 2 minutes. Apps that use this database get errors until it's restored (possible for 1 year). Pausing frees one of this account's 2 free slots. Nothing is deleted.";
const RESTORE_BODY = "Supabase brings the project back in about 2 minutes. Apps that use it start working again after that.";

// The toast shows our own sentence (with the alias) on success, the server's sentence on failure.
const said = (message: string) => (r: ActionResult): ActionResult => (r.ok ? { ok: true, message } : r);

// metrics (Stage 12, owner only): adds "Add metrics key" / "Replace metrics key" to the menu. dashboard: whether to link
// out to the Supabase dashboard (false in demo, where the project is made up: lib/demo/links.ts).
export function ActiveRowMenu({ id, projectRef, alias, label, metrics, dashboard = true }: { id: string; projectRef: string; alias: string; label: string; metrics?: { hasKey: boolean }; dashboard?: boolean }) {
  const { open, dialog } = useProviderAction();
  const [keyOpen, setKeyOpen] = useState(false);
  return (
    <>
      <RowMenu label={label} items={[
        ...(dashboard ? [{ label: "Open in Supabase", href: `https://supabase.com/dashboard/project/${encodeURIComponent(projectRef)}` }] : []),
        { label: "Check services", later: 6 },
        ...(metrics ? [{ label: metrics.hasKey ? "Replace metrics key" : "Add metrics key", onSelect: () => setKeyOpen(true) }] : []),
        "---",
        {
          label: "Pause project", danger: true,
          onSelect: () => open({
            title: `Pause ${alias}?`, body: PAUSE_BODY, cta: "Pause project", danger: true,
            run: async () => said(`Pausing ${alias}. It takes about 2 minutes.`)(await pauseAction(id, projectRef)),
          }),
        },
      ]} />
      {dialog}
      {metrics && <MetricsKeyDialog id={id} projectRef={projectRef} alias={alias} hasKey={metrics.hasKey} open={keyOpen} onOpenChange={setKeyOpen} />}
    </>
  );
}

// Restore on a paused row. With a free slot: a plain confirm. Without one (mockup restoreDlg): pick an active project of
// the same account to pause first; Restore stays blocked until that one shows Paused (two steps, never automatic).
export function RestoreButton({ id, projectRef, alias, account, slotsLeft, choices }: {
  id: string; projectRef: string; alias: string; account: string; slotsLeft: number; choices: PauseChoice[];
}) {
  if (slotsLeft > 0) {
    // ProviderActionButton's trigger, at the mockup's small size (btn sm) for a table row.
    return (
      <ConfirmDialog
        trigger={<Button size="sm">Restore</Button>} title={`Restore ${alias}?`} body={RESTORE_BODY} cta="Restore"
        onConfirm={async () => {
          const r = await restoreAction(id, projectRef);
          return r.ok ? { ok: true, message: `Restoring ${alias}. It takes about 2 minutes.` } : { ok: false, message: r.error };
        }}
      />
    );
  }
  return <PauseFirstDialog alias={alias} account={account} choices={choices} />;
}

function PauseFirstDialog({ alias, account, choices }: { alias: string; account: string; choices: PauseChoice[] }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>(choices.at(-1)?.id ?? "");
  const [pending, start] = useTransition();
  const mask = useMask();
  useHoldRefresh(open);
  const pick = choices.find((c) => c.id === picked);
  function pauseSelected() {
    if (!pick) return;
    start(async () => {
      try {
        const r = await pauseAction(pick.id, pick.ref);
        if (!r.ok) { toast.error(r.error); return; }
        toast.success("Pause started", { description: `Pausing ${pick.alias}. Restore ${alias} once ${pick.alias} shows Paused, about 2 minutes.` });
        setOpen(false);
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); if (next) setPicked(choices.at(-1)?.id ?? ""); } }}>
      <DialogTrigger render={<Button size="sm">Restore</Button>} />
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconPlayerPlay size={19} /></span>
          <div>
            <DialogTitle className="text-base">Restore {alias}?</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">Account <Masked kind="account" real={account} /> already uses both free slots. Pick a project to pause first.</DialogDescription>
          </div>
        </div>
        <div className="px-[18px] pb-2">
          {choices.length ? (
            <div className="max-h-[260px] overflow-y-auto">
              {choices.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-3 border-b border-line px-1 py-[9px] last:border-b-0 hover:bg-hover">
                  <input type="radio" name="pause-first" className="size-4 accent-brand" checked={picked === c.id} onChange={() => setPicked(c.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">Pause {c.alias}</span>
                    <span className="block truncate text-[12px] text-ink-faint">Last API traffic {c.traffic}{c.usedBy.length ? ` · used by ${c.usedBy.map((u) => mask("app", u)).join(", ")}` : ""}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="my-2 text-[13px] text-ink-soft">The console doesn&apos;t watch this account&apos;s active projects, so pause one in Supabase first.</p>
          )}
          <p className="mb-2 mt-3 text-[13px] text-ink-soft">Apps that use the paused project get errors until you restore it. You can also move {alias} to another account with a free slot instead.</p>
          <p className="mb-3 text-[13px] text-ink-soft">Restore stays blocked until the project you pause shows Paused (about 2 minutes). Then press Restore again.</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
          <Button onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button variant="danger" disabled={pending || !pick} onClick={pauseSelected}>{pending ? "Working…" : "Pause selected"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SAVED = {
  keep: (a: string, on: boolean) => (on ? `${a}: warning from day 5 without API traffic, and one keep-alive query a day.` : `${a} may pause after 7 idle days.`),
  autoRestore: (a: string, on: boolean) => (on ? `${a} is restored automatically when its account has a free slot.` : `${a} is no longer restored automatically.`),
};

// Mockup: the "Keep active" column. Owner only; other roles see the boxes disabled with "Owner only". Console rows only,
// so no confirm dialog (A3).
export function KeepActiveBoxes({ id, alias, keep, autoRestore, owner, sent }: {
  id: string; alias: string; keep: boolean; autoRestore: boolean; owner: boolean; sent: string | null;
}) {
  const [value, setValue] = useState({ keep, autoRestore });
  const [pending, start] = useTransition();
  function change(field: "keep" | "autoRestore", on: boolean) {
    const before = value;
    setValue({ ...value, [field]: on });
    start(async () => {
      try {
        const r = await (field === "keep" ? setKeepActive : setAutoRestore)(id, on);
        if (!r.ok) { setValue(before); toast.error(r.error); return; }
        toast.success("Keep active saved", { description: SAVED[field](alias, on) });
      } catch {
        setValue(before);
        toast.error("Something went wrong. Try again.");
      }
    });
  }
  const box = (field: "keep" | "autoRestore", text: string) => (
    <label className="flex items-center gap-1.5 text-[13px]" title={owner ? undefined : "Owner only"}>
      <input type="checkbox" className="size-4 accent-brand" checked={value[field]} disabled={!owner || pending} onChange={(e) => change(field, e.target.checked)} />
      {text}
    </label>
  );
  return (
    <div>
      <div className="flex flex-col items-start gap-0.5">{box("keep", "Keep active")}{box("autoRestore", "Auto-restore")}</div>
      {sent && <div className="text-[12px] text-ink-faint">Keep-alive sent {sent}</div>}
    </div>
  );
}
