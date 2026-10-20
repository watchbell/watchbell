import { describe, expect, it } from "vitest";
import { confirmResult } from "@/lib/view/action-result";
import { buildAliasBook, maskText } from "@/lib/view/display-name";

// Stage 6 final review: a provider action's toast is the server's sentence, which names the app (or the Vercel host).
// In screenshot mode it must be masked like the dialog that asked for it.
describe("confirmResult", () => {
  const book = buildAliasBook([{ id: "a1", kind: "app", name: "portfolio-site", firstSeenAt: "2026-10-01T00:00:00.000Z" }]);
  const shot = (t: string) => maskText(t, book); // what useMask()("text", …) does in screenshot mode

  it("masks the app name in a success message in screenshot mode", () => {
    expect(confirmResult({ ok: true, message: "Redeploy requested. Vercel is building portfolio-site again." }, shot))
      .toEqual({ ok: true, message: "Redeploy requested. Vercel is building app-a again." });
  });

  it("masks the app name in a refusal", () => {
    expect(confirmResult({ ok: false, error: "A production build of portfolio-site is already running." }, shot))
      .toEqual({ ok: false, message: "A production build of app-a is already running." });
  });

  it("keeps the text as is without a mask, and says Done. when the server sent no message", () => {
    expect(confirmResult({ ok: true }, (t) => t)).toEqual({ ok: true, message: "Done." });
    expect(confirmResult({ ok: false, error: "Already live." })).toEqual({ ok: false, message: "Already live." });
  });
});
