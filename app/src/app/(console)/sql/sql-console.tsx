"use client";

import { IconPlayerPlay } from "@tabler/icons-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Banner, Button, fieldClass } from "@/components/kit";
import { td, tableClass, TableHead } from "@/components/table";
import { cn } from "@/lib/utils";
import { BUILTIN_SNIPPETS, LOCAL_SNIPPETS_KEY, MAX_LOCAL_SNIPPETS, parseLocalSnippets, type Snippet } from "@/lib/sql/snippets";
import { ROW_CAP } from "@/lib/sql/run";
import { WAKE_TEXT } from "@/lib/sql/targets";
import { runSqlAction, type SqlRunData } from "./actions";

// Stage 9 slice 2: the SQL console. Every guard is enforced on the server (lib/sql/guard.ts, lib/sql/run.ts); this
// component only collects the query and shows the answer. Saved snippets stay in this browser's localStorage.

export type ConsoleTarget = { id: string; alias: string; provider: "supabase" | "neon"; wake: "idle" | "active" | "unknown" | null };
type Run = NonNullable<SqlRunData["run"]>;

function readLocal(): Snippet[] {
  try {
    return parseLocalSnippets(window.localStorage.getItem(LOCAL_SNIPPETS_KEY));
  } catch {
    return [];
  }
}

function writeLocal(list: Snippet[]): boolean {
  try {
    window.localStorage.setItem(LOCAL_SNIPPETS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const cellText = (v: unknown) => (v === null ? "NULL" : typeof v === "string" ? v : String(v));

export function SqlConsole({ targets }: { targets: ConsoleTarget[] }) {
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [sql, setSql] = useState(BUILTIN_SNIPPETS[0].sql);
  const [local, setLocal] = useState<Snippet[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wakeOpen, setWakeOpen] = useState(false);
  const [pending, start] = useTransition();
  // localStorage is read after mount, so the server render and the first client render match.
  useEffect(() => {
    const t = setTimeout(() => setLocal(readLocal()), 0);
    return () => clearTimeout(t);
  }, []);
  const chosen = targets.find((t) => t.id === target);

  async function exec(confirmWake: boolean): Promise<{ ok: boolean; message: string }> {
    const r = await runSqlAction(target, sql, confirmWake);
    if (r.ok && r.data?.run) {
      setRun(r.data.run);
      setError(null);
      return { ok: true, message: `${r.data.run.rowCount} row${r.data.run.rowCount === 1 ? "" : "s"} in ${r.data.run.durationMs} ms` };
    }
    if (!r.ok && r.data?.needsWake) {
      setWakeOpen(true);
      return { ok: false, message: WAKE_TEXT };
    }
    setRun(null);
    setError(r.ok ? "No result." : r.error);
    return { ok: false, message: r.ok ? "No result." : r.error };
  }

  function go() {
    if (!target || !sql.trim() || pending) return;
    // Known idle (or unknown) Neon compute: ask first, without a round trip.
    if (chosen?.provider === "neon" && chosen.wake !== "active") {
      setWakeOpen(true);
      return;
    }
    start(async () => {
      try {
        await exec(false);
      } catch {
        setError("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  function saveSnippet() {
    const label = window.prompt("Name this snippet (saved in this browser only)")?.trim();
    if (!label) return;
    const next = [{ id: `local-${Date.now()}`, label: label.slice(0, 60), sql }, ...local].slice(0, MAX_LOCAL_SNIPPETS);
    if (writeLocal(next)) {
      setLocal(next);
      toast.success("Snippet saved in this browser");
    } else toast.error("This browser didn't let the console save it.");
  }

  function removeSnippet(id: string) {
    const next = local.filter((s) => s.id !== id);
    if (writeLocal(next)) setLocal(next);
  }

  const all = [...BUILTIN_SNIPPETS, ...local];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Database
          <select className={cn(fieldClass, "w-56")} value={target} onChange={(e) => { setTarget(e.target.value); setRun(null); setError(null); }}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.alias} · {t.provider === "supabase" ? "Supabase" : "Neon"}{t.wake === "idle" ? " (idle)" : ""}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Snippet
          <select className={cn(fieldClass, "w-64")} value="" onChange={(e) => { const s = all.find((x) => x.id === e.target.value); if (s) setSql(s.sql); }}>
            <option value="" disabled>Insert a snippet…</option>
            <optgroup label="Built in">{BUILTIN_SNIPPETS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</optgroup>
            {local.length > 0 && <optgroup label="Saved in this browser">{local.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</optgroup>}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={saveSnippet} disabled={!sql.trim()}>Save as snippet</Button>
          <Button variant="primary" onClick={go} disabled={pending || !target || !sql.trim()}>
            <IconPlayerPlay size={15} /> {pending ? "Running…" : "Run"}
          </Button>
        </div>
      </div>
      <textarea
        aria-label="SQL query" spellCheck={false} rows={10} value={sql}
        className={cn(fieldClass, "min-h-[180px] resize-y font-mono text-[13px] leading-relaxed")}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } }}
      />
      <p className="text-[12.5px] text-ink-soft">
        One SELECT, WITH, EXPLAIN, SHOW or TABLE statement. It runs in a read-only transaction that is always rolled back, with a 5 s timeout and at most {ROW_CAP} rows. Ctrl+Enter runs it. 20 runs per 10 minutes.
      </p>
      {local.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[12.5px] text-ink-soft">
          Saved here:
          {local.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded border border-line px-1.5">
              <button type="button" className="text-ink hover:underline" onClick={() => setSql(s.sql)}>{s.label}</button>
              <button type="button" aria-label={`Delete snippet ${s.label}`} className="text-ink-faint hover:text-err" onClick={() => removeSnippet(s.id)}>×</button>
            </span>
          ))}
        </div>
      )}
      {error && <Banner tone="danger" title="The query didn't run">{error}</Banner>}
      {run && <Results run={run} />}
      <ConfirmDialog
        open={wakeOpen} onOpenChange={setWakeOpen} title={`Wake ${chosen?.alias ?? "the database"}?`} cta="Run anyway"
        body={WAKE_TEXT}
        onConfirm={async () => {
          try {
            return await exec(true);
          } catch {
            return { ok: false, message: "Watchbell didn't answer. Check that it's still running, then try again." };
          }
        }}
      />
    </div>
  );
}

function Results({ run }: { run: Run }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-soft">
        <span><b className="font-mono font-medium text-ink">{run.rowCount}</b> row{run.rowCount === 1 ? "" : "s"}</span>
        <span><b className="font-mono font-medium text-ink">{run.durationMs}</b> ms</span>
        {run.truncated && <span className="rounded border border-warn-icon/40 bg-warn-soft px-1.5 text-ink">Truncated: more rows or data than the console shows</span>}
      </div>
      {run.columns.length === 0 ? (
        <p className="text-[13px] text-ink-soft">The statement returned no columns.</p>
      ) : (
        <div className="max-h-[520px] overflow-auto rounded-md border border-line">
          <table className={cn(tableClass, "font-mono text-[12.5px]")}>
            <TableHead head={run.columns} />
            <tbody>
              {run.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={cn(td, "max-w-[420px] overflow-hidden text-ellipsis", v === null && "text-ink-faint")} title={cellText(v).length > 60 ? cellText(v) : undefined}>
                      {cellText(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
