"use client";

import { IconLoader2, IconMessage2 } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/kit";
import { ASK_COPY, WHY_COPY } from "@/lib/copy/edition";
import { askAntigravity, askWhy } from "@/private/assist/actions";
import { Markdown } from "@/private/notes/markdown";
import { ago } from "@/lib/time";
import { AiBox } from "./ai-box";
import { Thinking } from "./thinking";

// "Ask AI" under the problems of the Why dialog (mockup EXTRA_DLG.why). Two ways, both owner only:
//  - "Answer now with <model>" when a provider is connected: one call through the gateway, shown here, not stored.
//  - "Ask Antigravity" only while Antigravity is connected: the scrubbed question goes to the inbox (ops.ai_questions);
//    this shows "Waiting for Antigravity…" and then the answer, which arrives with the page's normal 60 s refresh.
//  - Antigravity not connected (owner 14 Oct): one "Ask <model>" button; the provider answers right away and the
//    question is kept with its answer (AI › Ask shows it), with "Thinking… N s" while it runs.
export type QuestionProps = { id: string; status: "pending" | "answered" | "expired"; answer: string | null; client: string | null; model: string | null; createdAt: string; answeredAt: string | null };

export function WhyAi({ appId, provider, question, nowMs, agConnected = false }: { appId: string; provider: { model: string } | null; question: QuestionProps | null; nowMs: number; agConnected?: boolean }) {
  const [busy, start] = useTransition();
  const [which, setWhich] = useState<"now" | "ag" | null>(null);
  const [answer, setAnswer] = useState<{ text: string; model: string; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date(nowMs);
  const waiting = question?.status === "pending";

  const run = (kind: "now" | "ag") => {
    setError(null);
    setWhich(kind);
    start(async () => {
      try {
        if (kind === "now") {
          const r = await askWhy(appId);
          if (r.ok && r.data) setAnswer(r.data);
          else if (!r.ok) setError(r.error);
        } else {
          const r = await askAntigravity(appId);
          if (r.ok) {
            if (r.data?.status === "answered" && r.data.text) setAnswer({ text: r.data.text, model: r.data.model ?? "", ms: r.data.ms ?? 0 });
            else toast.success(r.message ?? "Sent.");
          } else setError(r.error);
        }
      } catch {
        setError("Something went wrong. Try again.");
      }
    });
  };

  return (
    <div className="border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {agConnected ? (
          <>
            {provider && (
              <Button size="sm" disabled={busy} onClick={() => run("now")}>
                <IconMessage2 size={15} aria-hidden />{busy && which === "now" ? "Asking…" : `Answer now with ${provider.model}`}
              </Button>
            )}
            <Button size="sm" disabled={busy || waiting} onClick={() => run("ag")}>
              <IconMessage2 size={15} aria-hidden />{busy && which === "ag" ? "Sending…" : question && question.status !== "pending" ? WHY_COPY.askAgain : WHY_COPY.ask}
            </Button>
          </>
        ) : provider ? (
          <Button size="sm" disabled={busy} onClick={() => run("ag")}>
            <IconMessage2 size={15} aria-hidden />{busy ? "Asking…" : `Ask ${provider.model}`}
          </Button>
        ) : (
          <span className="text-[13px] text-ink-soft">No AI provider is connected. Connect one under AI Gateway › Bring your own key.</span>
        )}
        {busy && <Thinking />}
      </div>
      <p className="mt-1.5 text-[12px] text-ink-faint">
        Sends the problems above with names aliased. {agConnected ? `${provider ? "Answer now stores nothing; " : ""}${WHY_COPY.keptNote}` : "The question and its answer are kept for 7 days on AI › Ask."}
      </p>

      {error && <p role="alert" className="mt-2 text-[13px] text-err">{error}</p>}

      {answer && (
        <AiBox className="mt-2.5" icon={<IconMessage2 size={18} aria-hidden />}
          meta={`AI · ${answer.model} · ${(answer.ms / 1000).toFixed(1)} s · sent: the problems above, names aliased · can be wrong`}>
          <b className="font-medium">What&rsquo;s likely going on</b>
          <Markdown source={answer.text} />
        </AiBox>
      )}

      {question?.status === "pending" && (
        <AiBox className="mt-2.5" icon={<IconLoader2 size={18} className="animate-spin" aria-hidden />}
          meta={`Asked ${ago(new Date(question.createdAt), now)} · it answers when it next checks in; this page refreshes by itself`}>
          <p role="status">{ASK_COPY.waiting}</p>
        </AiBox>
      )}

      {question?.status === "answered" && question.answer && (
        <AiBox className="mt-2.5" icon={<IconMessage2 size={18} aria-hidden />}
          meta={`AI · ${[question.client, question.model].filter(Boolean).join(" · ") || WHY_COPY.answeredFallback} · ${question.answeredAt ? ago(new Date(question.answeredAt), now) : ""} · sent: the problems above, names aliased · written by an agent, can be wrong`}>
          <b className="font-medium">{question.client === "watchpost" ? "The answer" : WHY_COPY.answerTitle}</b>
          <Markdown source={question.answer} />
        </AiBox>
      )}

      {question?.status === "expired" && (
        <p className="mt-2.5 text-[12.5px] text-ink-soft">{WHY_COPY.expired(ago(new Date(question.createdAt), now))} Check that an agent is connected under AI Gateway › Connect an agent.</p>
      )}
    </div>
  );
}
