import { IconMessage2, IconNotes } from "@tabler/icons-react";
import Link from "next/link";
import { pageGate } from "@/lib/auth";
import { WHY_COPY } from "@/lib/copy/edition";
import { ago } from "@/lib/time";
import { ports } from "@/private/assist/ports";
import { readSummary } from "@/private/assist/summary";
import { listNotes } from "@/private/notes/notes-view";
import { Markdown } from "@/private/notes/markdown";
import { AiBox } from "./ai-box";
import { RegenerateButton } from "./regenerate-button";

// Registry slot RecSummarySlot (mockup aiSummary()), top of the Recommendations card on Overview, owner only.
//  - a provider is connected and a summary is stored: the summary, with Regenerate;
//  - a provider is connected, none stored yet: a one-line "Summarise" so the owner needn't wait for 03:00;
//  - no provider: a short link to connect Antigravity (hidden once notes from an agent exist: it is already connected).
export async function RecSummarySlot({ count }: { count: number }) {
  const { ok } = await pageGate("owner");
  if (!ok) return null;
  const provider = await ports.provider().catch(() => null);
  if (!provider) {
    const notes = await listNotes(undefined, new Date()).catch(() => []);
    if (notes.length) return null;
    return (
      <p className="mb-3 flex items-center gap-1.5 text-[13px] text-ink-soft">
        <IconNotes size={16} aria-hidden className="text-ink-faint" />
        <Link href="/ai/connect">{WHY_COPY.recConnect}</Link>
      </p>
    );
  }
  if (count === 0) return null;
  const summary = await readSummary().catch(() => null);
  if (!summary) {
    return (
      <p className="mb-3 flex items-center gap-1.5 text-[13px] text-ink-soft">
        <IconMessage2 size={16} aria-hidden className="text-ink-faint" />
        No AI summary yet. <RegenerateButton label="Summarise" />
      </p>
    );
  }
  const now = new Date();
  return (
    <AiBox
      className="mb-3" icon={<IconMessage2 size={18} aria-hidden />}
      meta={<>{`AI · ${summary.model} · ${ago(new Date(summary.at), now)} · from ${summary.count} items, names aliased · can be wrong, check the items below · `}<RegenerateButton label="Regenerate" /></>}
    >
      <b className="font-medium">Summary</b>
      <Markdown source={summary.text} />
    </AiBox>
  );
}
