import { PLAYGROUND_COPY } from "@/lib/copy/edition";
import { QUESTION_MAX } from "@/private/assist/question-input";

// The Playground with Antigravity (owner 13 Oct 18:05). Pure: how earlier turns are folded into the one inbox question
// Antigravity answers (it has no chat API: each question stands alone, so the last turns go in front of it as text).
// No "use client", no server-only: the view folds the question. The picker's data is built by the page (picker.ts).

export const AG_HINT = PLAYGROUND_COPY.hint;
export const FOLD_TURNS = 4;
const Q_CLIP = 300;
const A_CLIP = 600;

export type PickerOption = { id: string; label: string; via: "provider" | "antigravity" };
export type Turn = { q: string; a: string };

// Which way a picked model answers (an id that isn't offered: the provider way).
export const viaOf = (options: PickerOption[], id: string): PickerOption["via"] => options.find((o) => o.id === id)?.via ?? "provider";

// Each question with the answer right after it; a question without one (failed, still waiting) is left out.
export function turnsOf(msgs: { role: "user" | "assistant"; content: string }[]): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i + 1 < msgs.length; i++) {
    if (msgs[i].role === "user" && msgs[i + 1].role === "assistant") {
      out.push({ q: msgs[i].content, a: msgs[i + 1].content });
      i++;
    }
  }
  return out;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// "Earlier in this chat:\nQ: …\nA: …\n\nNow: …" with at most the last 4 turns, each clipped, dropping the oldest
// until the whole question fits in `max` (the inbox's 2000 characters). No room for any turn: the question alone.
export function foldQuestion(turns: Turn[], question: string, max: number = QUESTION_MAX): string {
  const now = question.trim();
  let lines = turns.slice(-FOLD_TURNS).map((t) => `Q: ${oneLine(t.q, Q_CLIP)}\nA: ${oneLine(t.a, A_CLIP)}`);
  while (lines.length > 0) {
    const text = `Earlier in this chat:\n${lines.join("\n")}\n\nNow: ${now}`;
    if (text.length <= max) return text;
    lines = lines.slice(1);
  }
  return now;
}
