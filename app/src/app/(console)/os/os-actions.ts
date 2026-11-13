"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { runOsScan, type StoredScan } from "@/lib/data/os-scan-db";

// DevOps › Security › OS vulnerabilities: Scan now is the owner's (it runs dpkg-query and apt list on the machine and
// asks Ubuntu's API and OSV.dev). The demo shows made-up data and doesn't scan.
export async function scanNowAction(): Promise<ActionResult<StoredScan>> {
  return runGuarded<StoredScan>("owner", async () => {
    const r = await runOsScan();
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  }, { requireActionMember }, async () => ({ ok: false, error: "Scanning is off in the demo." }));
}
