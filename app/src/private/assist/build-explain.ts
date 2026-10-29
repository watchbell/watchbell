import { ASSIST_COPY } from "@/lib/copy/edition";
import { redactCode } from "@/lib/code/redact";
import type { BuildLine } from "@/lib/view/build-logs";
import { overQuota, safeError } from "./limits";
import { type AssistPorts, ports } from "./ports";
import type { ChatMessage } from "./prompts";

// Watchbell 1.3 Explain with AI (the explainBuild slot): a failed build's log tail, secrets cut out, goes to the owner's
// AI provider once and comes back as what broke, the likely fix and the file. On demand only (the build-logs drawer's
// button); counts against the shared AI quota. Nothing is stored.

const MAX_LINES = 120;
const MAX_LINE = 400;
const TELLING = /error|failed|cannot|not found|exit code/i;
const TOO_LITTLE = "There is too little in the build log to explain.";

// The lines sent, in log order: every stderr line and every error-looking one first (the newest 120 of them if there
// are more), then the newest of the rest until there are 120. Empty lines and Vercel's section markers are dropped.
export function explainLines(lines: BuildLine[]): string[] {
  const usable = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind !== "delimiter" && l.text.trim() !== "");
  const telling = (l: BuildLine) => l.kind === "stderr" || TELLING.test(l.text);
  const first = usable.filter(({ l }) => telling(l)).slice(-MAX_LINES);
  const room = MAX_LINES - first.length;
  const rest = room > 0 ? usable.filter(({ l }) => !telling(l)).slice(-room) : [];
  return [...first, ...rest].sort((a, b) => a.i - b.i).map(({ l }) => redactCode(l.kind === "command" ? `$ ${l.text}` : l.text).slice(0, MAX_LINE)); // redact first: no half token
}

function explainPrompt(app: string, lines: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: "You read a web app's failed build log and explain it to its developer. Answer in at most 6 short lines of plain "
        + "text, no headings and no preamble: what broke, the likely fix, and the file (with the line, when the log names one). "
        + "If the log doesn't say enough, say what to look at next.",
    },
    { role: "user", content: `The build of ${app} failed. The end of its build log (secrets removed):\n\n${lines.join("\n")}` },
  ];
}

export type ExplainDeps = {
  overQuota(memberId: string): Promise<string | null>;
  provider: AssistPorts["provider"];
  complete: AssistPorts["complete"];
};

export async function explainBuildWith(deps: ExplainDeps, input: { app: string; lines: BuildLine[]; memberId: string }): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }> {
  const lines = explainLines(input.lines);
  if (lines.length < 3 || !lines.some((l) => TELLING.test(l))) return { ok: false, error: TOO_LITTLE };
  const over = await deps.overQuota(input.memberId);
  if (over) return { ok: false, error: over };
  if (!(await deps.provider())) return { ok: false, error: ASSIST_COPY.noProvider };
  try {
    const r = await deps.complete(explainPrompt(input.app, lines), { purpose: "ask-ai", maxTokens: 400 });
    const text = r.text.trim();
    return text ? { ok: true, text, model: r.model } : { ok: false, error: "The model returned no text. Try again." };
  } catch (e) {
    return { ok: false, error: safeError(e) };
  }
}

export const explainBuild = (input: { app: string; lines: BuildLine[]; memberId: string }) =>
  explainBuildWith({ overQuota, provider: ports.provider, complete: ports.complete }, input);
