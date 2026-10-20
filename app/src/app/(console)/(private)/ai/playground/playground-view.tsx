"use client";

import { IconLoader2, IconSend } from "@tabler/icons-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button, Card, Field, fieldClass } from "@/components/kit";
import { PLAYGROUND_COPY as PG } from "@/lib/copy/edition";
import { cn } from "@/lib/utils";
import { askGeneral, questionStatus } from "@/private/assist/actions";
import { Markdown } from "@/private/notes/markdown";
import { fmtLatency, fmtTokens } from "@/private/ui/view";
import { AG_HINT, FOLD_TURNS, foldQuestion, type PickerOption, turnsOf, viaOf } from "./fold";
import { playgroundSend } from "./actions";
import { DEFAULT_SYSTEM } from "./input";

export type ModelOption = PickerOption;
type Msg = { role: "user" | "assistant"; content: string; meta?: string; md?: boolean };
type Waiting = { id: string; model: string; startedAt: number };

// Antigravity answers through the inbox: poll every 3 s; give up waiting here after 10 minutes (the question stays on
// AI › Ask and its answer shows there).
const POLL_MS = 3000;
const GIVE_UP_MS = 10 * 60_000;
const AG_MAX = 2000;

// The Playground: the conversation lives in this component's state only (a reload clears it). Provider models: the
// whole conversation goes with each message, nothing is stored. Antigravity models (ag/<id>): the last turns are folded
// into one inbox question (askGeneral), then questionStatus is polled until the VM answers.
export function PlaygroundView({ models, defaultModel }: { models: ModelOption[]; defaultModel: string }) {
  const [model, setModel] = useState(models.some((m) => m.id === defaultModel) ? defaultModel : (models[0]?.id ?? ""));
  const [mode, setMode] = useState<"plain" | "console">("plain"); // owner 14 Oct: Plain by default
  const [temperature, setTemperature] = useState("0.4");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [system, setSystem] = useState(DEFAULT_SYSTEM);
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [now, setNow] = useState(0);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const ag = viaOf(models, model) === "antigravity";
  const busy = pending || waiting !== null;
  const providers = models.filter((m) => m.via === "provider");
  const agModels = models.filter((m) => m.via === "antigravity");
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [msgs, pending, waiting]);

  // While an Antigravity question waits: a 1 s clock for the counter and a 3 s status poll. A cleared chat (or a new
  // question) cancels both; a late answer is then dropped here and still shows on AI › Ask.
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let inFlight = false;
    const stop = (err: string | null) => { if (cancelled) return; setWaiting(null); if (err) setError(err); };
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (inFlight || cancelled) return;
      if (Date.now() - waiting.startedAt > GIVE_UP_MS) return stop(PG.giveUp);
      inFlight = true;
      try {
        const r = await questionStatus(waiting.id);
        if (cancelled) return;
        if (!r.ok) return stop(r.error);
        const d = r.data;
        if (d?.status === "answered") {
          const secs = Math.max(1, Math.round((Date.now() - waiting.startedAt) / 1000));
          setMsgs((m) => [...m, { role: "assistant", content: d.answer?.trim() || PG.emptyAnswer, md: true, meta: PG.answerMeta(d.model ?? waiting.model, secs) }]);
          stop(null);
        } else if (d?.status === "expired") {
          stop(PG.expired);
        }
      } catch {
        // A network blip: the next tick asks again.
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(clock); clearInterval(poll); };
  }, [waiting]);

  const sendProvider = (next: Msg[]) => {
    start(async () => {
      try {
        const r = await playgroundSend({
          model, mode, temperature: Number(temperature), maxTokens: Number(maxTokens), system,
          messages: next.map(({ role, content: c }) => ({ role, content: c })),
        });
        if (r.ok && r.data) {
          const d = r.data;
          setMsgs((m) => [...m, { role: "assistant", content: d.text, meta: `${d.model} · ${fmtTokens(d.tokensIn, d.tokensOut)} · ${fmtLatency(d.ms)}${d.grounded ? " · grounded on the console snapshot" : ""}` }]);
        } else {
          setError(r.ok ? "No answer." : r.error);
        }
      } catch {
        setError("Something went wrong. Try again.");
      }
    });
  };

  const sendAntigravity = (before: Msg[], content: string) => {
    const question = foldQuestion(turnsOf(before), content);
    const picked = model;
    start(async () => {
      try {
        const r = await askGeneral(question, picked);
        if (r.ok && r.data) {
          const t = Date.now();
          setNow(t);
          setWaiting({ id: r.data.id, model: picked, startedAt: t });
        } else {
          setError(r.ok ? PG.notTaken : r.error);
        }
      } catch {
        setError("Something went wrong. Try again.");
      }
    });
  };

  const send = () => {
    const content = text.trim();
    if (!content || busy || !model) return;
    const next: Msg[] = [...msgs, { role: "user", content }];
    setMsgs(next);
    setText("");
    setError(null);
    if (ag) sendAntigravity(msgs, content);
    else sendProvider(next);
  };

  const elapsed = waiting ? Math.max(0, Math.round((now - waiting.startedAt) / 1000)) : 0;

  return (
    <div className="grid grid-cols-1 gap-4 min-[1001px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card title="Chat">
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <select className={cn(fieldClass, "w-auto max-w-full")} aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {providers.length > 0 && agModels.length > 0 ? (
              <>
                <optgroup label="Real-time (provider)">{providers.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
                <optgroup label={`${PG.groupLabel} · ${AG_HINT}`}>{agModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
              </>
            ) : models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {ag ? (
            <span className="font-mono text-[12px] text-ink-faint">{AG_HINT}</span>
          ) : (
            <select className={cn(fieldClass, "w-auto")} aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value === "plain" ? "plain" : "console")}>
              <option value="plain">Plain model</option>
              <option value="console">Ask the console (uses read:status data)</option>
            </select>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setMsgs([]); setError(null); setWaiting(null); }} disabled={msgs.length === 0 && !error}>Clear</Button>
          <span className="ml-auto text-[12.5px] text-ink-soft">{ag ? "Also on AI › Ask" : "Not stored"}</span>
        </div>
        <div ref={box} className="flex max-h-[460px] min-h-[260px] flex-col gap-3 overflow-auto p-0.5" aria-live="polite">
          {msgs.length === 0 && <p className="m-auto text-[13px] text-ink-faint">Ask about your apps, or anything.</p>}
          {msgs.map((m, i) => (
            <div key={i} className={cn("max-w-[84%] rounded-lg border px-3 py-2", m.role === "user" ? "self-end border-transparent bg-brand-soft" : "border-line bg-surface")}>
              {m.md ? <div className="break-words"><Markdown source={m.content} /></div> : <p className="m-0 whitespace-pre-wrap break-words">{m.content}</p>}
              {m.meta && <span className="mt-1 block font-mono text-[11.5px] text-ink-faint">{m.meta}</span>}
            </div>
          ))}
          {pending && !waiting && <div className="self-start rounded-lg border border-line bg-surface px-3 py-2 text-ink-soft" role="status">{ag ? PG.sending : "Thinking..."}</div>}
          {waiting && (
            <div className="inline-flex items-center gap-1.5 self-start rounded-lg border border-line bg-surface px-3 py-2 text-ink-soft" role="status">
              <IconLoader2 size={14} className="animate-spin" aria-hidden />
              {PG.thinking} <span className="font-mono text-[12px] text-ink-faint" aria-hidden>{elapsed} s</span>
            </div>
          )}
        </div>
        {error && <p className="mt-2 text-[13px] text-err" role="alert">{error}</p>}
        <div className="mt-3 flex items-end gap-2">
          <textarea
            className={cn(fieldClass, "min-h-11 flex-1")}
            placeholder="Ask about your apps, or anything"
            aria-label="Message"
            value={text}
            maxLength={ag ? AG_MAX : 8000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
          />
          <Button variant="primary" onClick={send} disabled={busy || !text.trim() || !model}><IconSend size={16} aria-hidden />Send</Button>
        </div>
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        <Card title="Settings" meta={ag ? "Provider models only" : undefined}>
          <Field id="pg-temp" label="Temperature"><input id="pg-temp" className={cn(fieldClass, "font-mono")} inputMode="decimal" value={temperature} disabled={ag} onChange={(e) => setTemperature(e.target.value)} /></Field>
          <Field id="pg-max" label="Max output tokens"><input id="pg-max" className={cn(fieldClass, "font-mono")} inputMode="numeric" value={maxTokens} disabled={ag} onChange={(e) => setMaxTokens(e.target.value)} /></Field>
          <Field id="pg-sys" label="System prompt"><textarea id="pg-sys" className={cn(fieldClass, "min-h-24")} value={system} maxLength={4000} disabled={ag} onChange={(e) => setSystem(e.target.value)} /></Field>
        </Card>
        {ag ? (
          <Card title={PG.howTitle}>
            <p className="m-0 text-[13px] text-ink-soft">
              {PG.howBody}{" "}
              The last {FOLD_TURNS} turns of this chat go in front of the question (up to 2,000 characters). The question and answer are kept 7 days and show on AI › Ask.
            </p>
          </Card>
        ) : (
          <Card title="What's sent in console mode">
            <p className="m-0 text-[13px] text-ink-soft">
              A compact summary of /api/v1/status: app names and states, monitor results, open alerts, Why problems. Databases as aliases, no URLs, emails, IPs or tokens.
              Sent to the chosen provider with your question; not stored by Watchbell. Messages count toward the provider&apos;s quota.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
