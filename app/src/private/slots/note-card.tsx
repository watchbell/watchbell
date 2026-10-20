import { IconNotes } from "@tabler/icons-react";
import { MaskedText } from "@/components/alias";
import { ago } from "@/lib/time";
import { Markdown } from "@/private/notes/markdown";
import type { NoteView } from "@/private/notes/notes-view";
import { AiBox } from "./ai-box";
import { DismissNoteButton } from "./dismiss-note-button";

const TONE = { crit: "err", warn: "warn", info: "brand" } as const;

// One AI note (mockup aiNotes()): severity-coloured left rule, title, the body as safe markdown, a one-line source.
export function NoteCard({ note, now, showApp }: { note: NoteView; now: Date; showApp: boolean }) {
  const meta = [
    "AI note", `from ${note.from}`, note.model, ago(note.at, now), showApp && note.appName ? note.appName : null, "written by an agent, can be wrong",
  ].filter(Boolean).join(" · ");
  return (
    <AiBox
      icon={<IconNotes size={18} aria-hidden />} tone={TONE[note.severity] ?? "brand"} meta={meta}
      action={<DismissNoteButton id={note.id} />}
    >
      <b className="font-medium"><MaskedText text={note.title} /></b>
      <Markdown source={note.body} />
    </AiBox>
  );
}
