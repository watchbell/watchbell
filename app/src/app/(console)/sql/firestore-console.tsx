"use client";

import { IconPlayerPlay, IconPlus, IconX } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { Banner, Button, fieldClass } from "@/components/kit";
import { FS_MAX_LIMIT, FS_MAX_WHERE, FS_OPS, FS_TYPES, type FsOp, type FsType } from "@/lib/providers/firestore-query";
import { cn } from "@/lib/utils";
import { firestoreCollectionsAction, firestoreQueryAction, type FsRunData } from "./actions";

// Stage 9 slice 2: the read-only Firestore query builder. The server validates and builds the query again
// (lib/providers/firestore-query.ts); this form only collects it.

export type FirestoreTarget = { id: string; alias: string; readsToday: number | null };
type Where = { key: number; field: string; op: FsOp; type: FsType; value: string };
type Run = NonNullable<FsRunData["run"]>;

export function FirestoreConsole({ targets }: { targets: FirestoreTarget[] }) {
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [collections, setCollections] = useState<string[] | null>(null);
  const [more, setMore] = useState(false);
  const [collection, setCollection] = useState("");
  const [where, setWhere] = useState<Where[]>([]);
  const [orderField, setOrderField] = useState("");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(20);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = targets.find((t) => t.id === target);

  function loadCollections() {
    start(async () => {
      try {
        const r = await firestoreCollectionsAction(target);
        if (!r.ok) { setError(r.error); return; }
        setCollections(r.data?.collections ?? []);
        setMore(Boolean(r.data?.more));
        setCollection(r.data?.collections?.[0] ?? "");
        setError(null);
      } catch {
        setError("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  function query() {
    start(async () => {
      try {
        const r = await firestoreQueryAction(target, {
          collection,
          where: where.map(({ field, op, type, value }) => ({ field: field.trim(), op, type, value })),
          orderBy: orderField.trim() ? { field: orderField.trim(), dir: orderDir } : null,
          limit,
        });
        if (!r.ok) { setError(r.error); setRun(null); return; }
        setRun(r.data?.run ?? null);
        setError(null);
      } catch {
        setError("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  const patch = (key: number, p: Partial<Where>) => setWhere((w) => w.map((x) => (x.key === key ? { ...x, ...p } : x)));

  return (
    <div className="flex flex-col gap-3">
      <Banner tone="warning" title="Every query costs Firestore reads">
        One read per document returned (at least one per query), from the free 50,000 a day. Listing collections costs one read.
        {chosen?.readsToday != null ? ` This project has used ${chosen.readsToday.toLocaleString("en")} today.` : ""}
      </Banner>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Project
          <select className={cn(fieldClass, "w-56")} value={target} onChange={(e) => { setTarget(e.target.value); setCollections(null); setCollection(""); setRun(null); }}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.alias}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Collection
          {collections ? (
            <select className={cn(fieldClass, "w-56 font-mono")} value={collection} onChange={(e) => setCollection(e.target.value)}>
              {collections.length === 0 && <option value="">No collections</option>}
              {collections.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <Button onClick={loadCollections} disabled={pending || !target}>{pending ? "Loading…" : "List root collections"}</Button>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Order by
          <input className={cn(fieldClass, "w-40 font-mono")} placeholder="field (optional)" value={orderField} onChange={(e) => setOrderField(e.target.value)} />
        </label>
        <select aria-label="Direction" className={cn(fieldClass, "w-24")} value={orderDir} onChange={(e) => setOrderDir(e.target.value === "desc" ? "desc" : "asc")}>
          <option value="asc">asc</option><option value="desc">desc</option>
        </select>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Limit
          <input type="number" min={1} max={FS_MAX_LIMIT} className={cn(fieldClass, "w-20 font-mono")} value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(FS_MAX_LIMIT, Math.round(Number(e.target.value) || 1))))} />
        </label>
        <Button variant="primary" className="ml-auto" onClick={query} disabled={pending || !collection}>
          <IconPlayerPlay size={15} /> {pending ? "Running…" : "Run query"}
        </Button>
      </div>
      {more && <p className="text-[12.5px] text-ink-soft">Showing the first 100 collections.</p>}
      <div className="flex flex-col gap-2">
        {where.map((w) => (
          <div key={w.key} className="flex flex-wrap items-center gap-2">
            <span className="w-12 text-[12.5px] text-ink-soft">where</span>
            <input aria-label="Field" className={cn(fieldClass, "w-44 font-mono")} placeholder="field" value={w.field} onChange={(e) => patch(w.key, { field: e.target.value })} />
            <select aria-label="Operator" className={cn(fieldClass, "w-44 font-mono")} value={w.op} onChange={(e) => patch(w.key, { op: e.target.value as FsOp })}>
              {(Object.keys(FS_OPS) as FsOp[]).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select aria-label="Value type" className={cn(fieldClass, "w-28")} value={w.type} onChange={(e) => patch(w.key, { type: e.target.value as FsType })}>
              {FS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input aria-label="Value" className={cn(fieldClass, "w-56 font-mono")} disabled={w.type === "null"}
              placeholder={w.op === "in" || w.op === "not-in" || w.op === "array-contains-any" ? "a, b, c" : "value"} value={w.value} onChange={(e) => patch(w.key, { value: e.target.value })} />
            <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => setWhere((x) => x.filter((y) => y.key !== w.key))}><IconX size={14} /></Button>
          </div>
        ))}
        {where.length < FS_MAX_WHERE && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setWhere((x) => [...x, { key: Date.now(), field: "", op: "==", type: "string", value: "" }])}>
              <IconPlus size={14} /> Add where
            </Button>
          </div>
        )}
      </div>
      {error && <Banner tone="danger" title="The query didn't run">{error}</Banner>}
      {run && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-3 text-[12.5px] text-ink-soft">
            <span><b className="font-mono font-medium text-ink">{run.docs.length}</b> document{run.docs.length === 1 ? "" : "s"}</span>
            <span><b className="font-mono font-medium text-ink">{run.reads}</b> read{run.reads === 1 ? "" : "s"} used</span>
            <span><b className="font-mono font-medium text-ink">{run.durationMs}</b> ms</span>
            {run.truncated && <span className="rounded border border-warn-icon/40 bg-warn-soft px-1.5 text-ink">Truncated</span>}
          </div>
          <div className="max-h-[520px] overflow-auto rounded-md border border-line">
            {run.docs.length === 0 ? <p className="px-3 py-2 text-[13px] text-ink-soft">No documents matched.</p> : run.docs.map((d) => (
              <div key={d.id} className="border-b border-line px-3 py-2 last:border-b-0">
                <div className="font-mono text-[12.5px] font-medium text-ink">{d.id}</div>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] text-ink-soft">{d.json}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
