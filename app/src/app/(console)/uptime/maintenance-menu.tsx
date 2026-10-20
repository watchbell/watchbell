"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RowMenu } from "@/components/row-menu";
import { actionsLabel } from "@/lib/view/labels";
import { removeWindow } from "../maintenance-actions";
import { type EditableWindow, MaintenanceDialog, type TargetOptions } from "./maintenance-dialog";

// Uptime → Maintenance windows → a row's kebab (mockup: Edit window, Delete).
export function MaintenanceMenu({ win, options }: { win: EditableWindow; options: TargetOptions }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
      <RowMenu label={actionsLabel(win.target, "window")} items={[
        { label: "Edit window", onSelect: () => setEditOpen(true) },
        "---",
        { label: "Delete", danger: true, onSelect: () => setDeleteOpen(true) },
      ]} />
      {editOpen && <MaintenanceDialog mode="edit" win={win} options={options} open onOpenChange={setEditOpen} />}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this maintenance window?"
        body="Checks count toward uptime % and open alerts again outside any other window."
        cta="Delete"
        danger
        onConfirm={async () => {
          const r = await removeWindow(win.id);
          return { ok: r.ok, message: (r.ok ? r.message : r.error) ?? "" };
        }}
      />
    </>
  );
}
