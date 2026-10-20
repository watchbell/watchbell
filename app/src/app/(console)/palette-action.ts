"use server";

import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { paletteSource } from "@/lib/data/palette-db";
import type { PaletteSource } from "@/lib/view/palette";

// Ctrl K palette: the watched apps and monitors to jump to. Any member may read it (a Viewer sees the apps pages too),
// and it returns only ids, names, domains and paths. The client calls it once, the first time the palette opens.
export async function loadPaletteSource(): Promise<ActionResult<PaletteSource>> {
  return runGuarded("viewer", async (): Promise<ActionResult<PaletteSource>> => ({ ok: true, data: await paletteSource() }), { requireActionMember }, "local");
}
