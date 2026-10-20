import type { ConsoleSnapshot, SnapshotApp } from "@/private/console/types";

// Prompts for the console's own AI and the question text queued for Antigravity (R5). Pure: they take already scrubbed
// snapshot data (Task 5's consoleSnapshot/appDetail: database aliases, no emails, URLs as paths) and, as a second line
// of defence, run every string through guard(): URLs, addresses, key-shaped tokens and connection strings never get
// out of this file even if a field slipped through upstream. Prompts and answers are never stored by this feature
// (only an Antigravity question and its answer, which live in ops.ai_questions for 7 days).

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type SnapshotRec = NonNullable<ConsoleSnapshot["advisor"]>[number];

export const SYSTEM_PROMPT =
  "You are the assistant inside Watchbell, a console that monitors the owner's web apps. Answer only from the data in the user's message. " +
  "Say so plainly when the data does not cover the question. Never invent names, numbers, dates or causes. " +
  "Names such as db-a or account-1 are aliases of private names: use them as written and do not guess what they stand for. " +
  "Be brief and concrete. Short markdown is fine; no HTML.";

const FIELD_MAX = 300;
const QUESTION_MAX = 2000; // ops.ai_questions.question check

// The last filter. Order matters: URLs first (they contain "@" and ":"), then key shapes, then the rest.
export function guard(text: unknown, max = FIELD_MAX): string {
  const s = String(text ?? "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[url]")
    .replace(/\b(?:wp|hb)_[A-Za-z0-9]{6,}/g, "[secret]")
    .replace(/\b(?:sk-|gsk_|AIza|AQ\.)[A-Za-z0-9_.-]{6,}/g, "[secret]")
    .replace(/postgres(?:ql)?/gi, "[db]")
    .replace(/@/g, "(at)")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function appLines(app: SnapshotApp): string[] {
  const lines = [
    `App: ${guard(app.id, 80)}`,
    `State: ${guard(app.state, 20)}`,
    `Uptime, last 30 days: ${app.uptime30d === null ? "unknown" : `${Math.round(app.uptime30d * 100) / 100}%`}`,
    `Database: ${app.database ? guard(app.database, 40) : "none"}`,
    `Last deploy: ${app.lastDeploy ? guard(app.lastDeploy, 40) : "unknown"}`,
  ];
  if (!app.problems.length) lines.push("Problems: none reported.");
  else {
    lines.push("Problems:");
    app.problems.slice(0, 10).forEach((p, i) => {
      lines.push(`${i + 1}. [${guard(p.kind, 30)}] ${guard(p.where, 120)}: ${guard(p.what)}${p.fix ? ` What the console suggests: ${guard(p.fix)}` : ""}`);
    });
  }
  return lines;
}

export function whyPrompt(app: SnapshotApp): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: ["Explain in at most five sentences what is likely going on with this app and what to do first.", "", ...appLines(app)].join("\n") },
  ];
}

export function summaryPrompt(recs: SnapshotRec[]): ChatMessage[] {
  const list = recs.slice(0, 40).map((r) => `- [${guard(r.severity, 20)}] ${guard(r.title)} (app: ${guard(r.app, 80)})`);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [`Summarise these ${recs.length} recommendations in two or three sentences, most urgent first. Name each app once.`, "", ...list].join("\n") },
  ];
}

function deepGuard(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return guard(v);
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => deepGuard(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [guard(k, 40), deepGuard(x, depth + 1)]));
  return typeof v === "number" || typeof v === "boolean" || v === null ? v : null;
}

export function consoleChatPrompt(snapshot: ConsoleSnapshot, question: string): ChatMessage[] {
  const data = JSON.stringify(deepGuard(snapshot), null, 1);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Console data (scrubbed, generated ${guard(snapshot.generatedAt, 40)}):\n${data}\n\nQuestion: ${guard(question, QUESTION_MAX)}` },
  ];
}

// The text enqueued in ops.ai_questions for Antigravity (≤ 2000 characters). Built from the same scrubbed app data.
export function antigravityQuestion(app: SnapshotApp): string {
  const head = `Why is the app "${guard(app.id, 80)}" ${guard(app.state, 20)}, and what should the owner do first? Answer in short markdown (under 1,500 characters), only from this data; say so if it does not cover the cause.`;
  const text = [head, "", ...appLines(app)].join("\n");
  return text.length > QUESTION_MAX ? `${text.slice(0, QUESTION_MAX - 1)}…` : text;
}
