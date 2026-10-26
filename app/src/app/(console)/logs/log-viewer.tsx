"use client";

import { IconExternalLink } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useMask } from "@/components/alias";
import { Button, buttonClass, fieldClass } from "@/components/kit";
import { Src } from "@/components/sources";
import { cn } from "@/lib/utils";
import { emptyLogText, filterLines, levelBucket, readText, type WireLine } from "@/lib/view/logs";
import { readLastHour } from "./actions";

const LEVEL_TONE = { info: "text-code-info", warning: "text-code-warn", error: "text-code-err" } as const;
const MAX_LINES = 500;
const EVERY_MS = 15_000;

// Mockup logViewer(). "live" reads Vercel's request logs of the last hour through a server action (at most 8 s per app) and merges
// it with the stored lines of the last hour; "stored" shows what the collector copied (warning, error, fatal; 7 days).
// Stored lines come from the page, filtered here. The 15 s read runs only while the box is ticked, the tab is visible
// and the previous read has finished.
export function LogViewer({ mode, apps, appId, initial, vercelUrl }: {
  mode: "live" | "stored"; apps: { id: string; name: string }[]; appId?: string; initial: WireLine[]; vercelUrl: string | null;
}) {
  const live = mode === "live";
  const [lines, setLines] = useState<WireLine[]>(initial);
  // Screenshot mode masks the project names and any names, hosts or emails in the lines (display only).
  const mask = useMask();
  const [app, setApp] = useState("");
  const [level, setLevel] = useState("");
  const [text, setText] = useState("");
  const [auto, setAuto] = useState(true);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pendingRef = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const selected = apps.find((a) => a.name === app)?.id ?? null;
  const target = appId ?? selected;

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const fetchNow = useCallback(() => {
    start(async () => {
      const r = await readLastHour(target);
      if (!r.ok || !r.data) {
        setError(r.ok ? "Couldn't read the logs. Try again." : r.error);
        return;
      }
      setError(null);
      setProblems(r.data.problems);
      setLines(r.data.lines.slice(-MAX_LINES));
      setReadAt(Date.parse(r.data.readAt));
      setNow(Date.now());
    });
  }, [target]);

  // One read when the tab opens (and when another app is picked), then every 15 s. Both run from timers, so no state
  // is set in the effect body itself.
  useEffect(() => {
    if (!live) return;
    const first = setTimeout(fetchNow, 0);
    return () => clearTimeout(first);
  }, [live, fetchNow]);
  useEffect(() => {
    if (!live || !auto) return;
    const every = setInterval(() => {
      if (document.visibilityState === "visible" && !pendingRef.current) fetchNow();
    }, EVERY_MS);
    return () => clearInterval(every);
  }, [live, auto, fetchNow]);

  // The "read Ns ago" text needs a clock.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [live]);

  const shown = filterLines(lines, { app: appId ? "" : app, level, text });
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pt-3.5 max-[720px]:px-3.5">
        {!appId && (
          <select className={cn(fieldClass, "w-auto")} aria-label="Project" value={app} onChange={(e) => setApp(e.target.value)}>
            <option value="">All projects</option>
            {apps.map((a) => <option key={a.id} value={a.name}>{mask("app", a.name)}</option>)}
          </select>
        )}
        <select className={cn(fieldClass, "w-auto")} aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          {live && <option value="info">Info</option>}
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
        {live ? (
          <>
            <label className="inline-flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" className="accent-brand" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh every 15s
            </label>
            <Button size="sm" disabled={pending} onClick={fetchNow}>{pending ? "Fetching…" : "Fetch now"}</Button>
          </>
        ) : (
          <input className={cn(fieldClass, "w-[200px] max-[720px]:w-full")} placeholder="Search messages" aria-label="Search messages" value={text} onChange={(e) => setText(e.target.value)} />
        )}
        {vercelUrl && (
          <a href={vercelUrl} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: "ghost", size: "sm" })}>
            Open in Vercel <IconExternalLink size={14} aria-hidden />
          </a>
        )}
        <span className="ml-auto flex items-center text-[12.5px] text-ink-soft">
          {live ? <>Vercel request logs · last 1 hour · {readText(readAt, now)}<Src kind="api" /></> : <>Copied by the collector every 5 min · kept 7 days<Src kind="calc" /></>}
        </span>
      </div>
      {error && <p role="alert" className="px-[18px] pb-2 text-[12.5px] text-err max-[720px]:px-3.5">{error}</p>}
      {problems.length > 0 && <p className="px-[18px] pb-2 text-[12.5px] text-ink-soft max-[720px]:px-3.5">{mask("text", problems.join(" · "))}</p>}
      <div ref={box} tabIndex={0} aria-label={live ? "Request log lines of the last hour" : "Stored warning and error log lines"}
        className="h-[420px] overflow-auto rounded-b-lg bg-code-bg px-4 py-3 font-mono text-[12.5px] leading-[1.7] text-code-text">
        {shown.length === 0 ? (
          <div className="whitespace-normal text-code-dim">{emptyLogText({ live, reading: readAt === null && !error, level })}</div>
        ) : shown.map((l) => (
          <div key={l.id} className="whitespace-pre">
            <time className="text-code-dim">{l.time}</time>{" "}
            <span className={LEVEL_TONE[levelBucket(l.level)]}>{l.level.toUpperCase().padEnd(7)}</span>{" "}
            <span className="text-code-proj">{mask("app", l.app).padEnd(17)}</span>{" "}
            {mask("text", l.text)}
          </div>
        ))}
      </div>
    </>
  );
}
