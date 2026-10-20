import { pageGate } from "@/lib/auth";
import { listNotes } from "@/private/notes/notes-view";
import { NoteCard } from "./note-card";

// Registry slot AiNotesSlot (R2, R8): the agents' notes that haven't been dismissed. Overview shows every note (with
// the app named); an app's page only its own. Owner only; nothing when there are none or the read fails.
export async function AiNotesSlot({ appId }: { appId?: string }) {
  const { ok } = await pageGate("owner");
  if (!ok) return null;
  const now = new Date();
  const notes = await listNotes(appId, now).catch(() => []);
  if (!notes.length) return null;
  return (
    <div className="mb-3 flex flex-col gap-2.5">
      {notes.map((n) => <NoteCard key={n.id} note={n} now={now} showApp={appId === undefined} />)}
    </div>
  );
}
