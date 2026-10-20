"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kit";
import type { ActionResult } from "@/lib/action";

// Wake on an idle compute row (mockup neon(): a small button; confirmFor("Wake")). `run` is the server action already
// bound to its ids on the server, so this file never imports server-only code.
export function WakeButton({ endpoint, used, run }: { endpoint: string; used: string | null; run: () => Promise<ActionResult> }) {
  return (
    <ConfirmDialog
      trigger={<Button size="sm">Wake</Button>}
      title={`Wake ${endpoint}?`}
      body={`The compute starts now and runs until it has been idle for 5 minutes. It uses CU-hours${used ? ` (${used} used this month)` : ""}.`}
      cta="Wake compute"
      onConfirm={async () => {
        const r = await run();
        return r.ok ? { ok: true, message: r.message ?? "Done." } : { ok: false, message: r.error };
      }}
    />
  );
}
