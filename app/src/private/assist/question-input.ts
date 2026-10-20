import { looksLikeSecret } from "@/private/console/scrub";

// The one check for a question typed by a person (the Ask page's askGeneral) or sent by a key (POST
// /api/v1/ai/questions): trimmed, 1–2000 characters (the table's check), and never a key or token. Pure.
export const QUESTION_MAX = 2000;
export const SECRET_REFUSED = "That looks like a key or token. Remove it before sending.";

export type Checked = { ok: true; question: string } | { ok: false; error: string };

export function checkQuestion(raw: unknown): Checked {
  const question = typeof raw === "string" ? raw.trim() : "";
  if (!question) return { ok: false, error: "Type a question first." };
  if (question.length > QUESTION_MAX) return { ok: false, error: `A question can be up to ${QUESTION_MAX} characters.` };
  if (looksLikeSecret(question)) return { ok: false, error: SECRET_REFUSED };
  return { ok: true, question };
}
