import { agoShort } from "@/private/ai/time-text";
import type { ModelTest } from "./routing";

// What Models shows for a model's last Test / Scan (pure, shared by the page and its tests).
export type TestLabel = { tone: "ok" | "err" | "none"; text: string };

export function testLabel(t: ModelTest | null | undefined, now: Date): TestLabel {
  if (!t) return { tone: "none", text: "never tested" };
  const when = agoShort(new Date(t.at), now);
  if (t.ok) return { tone: "ok", text: `ok · ${(t.ms / 1000).toFixed(1)} s · ${when}` };
  return { tone: "err", text: `${t.error ?? "failed"} · ${when}` };
}
