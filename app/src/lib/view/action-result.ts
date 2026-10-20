import type { ActionResult } from "@/lib/action";

// Stage 6: a provider action's answer as the confirm dialog's toast. The server's sentence can name the app, so the
// caller passes the screenshot-mode mask (useMask's "text"), the same one the dialog's title went through. Pure.
export function confirmResult(r: ActionResult, show: (text: string) => string = (t) => t): { ok: boolean; message: string } {
  return r.ok ? { ok: true, message: show(r.message ?? "Done.") } : { ok: false, message: show(r.error) };
}
