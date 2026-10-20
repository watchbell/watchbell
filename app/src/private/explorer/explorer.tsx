"use client";

import { IconCopy, IconPlayerPlay, IconPlus, IconSend, IconTrash, IconX } from "@tabler/icons-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Banner, Button, Card, EmptyState, Field, fieldClass } from "@/components/kit";
import { StateIcon } from "@/components/status";
import { cn } from "@/lib/utils";
import { type ApiOp, bearerEnvOf, needsKey, opById, type ParamSpec } from "@/private/openapi/operations";
import {
  deleteExample, EXAMPLES_KEY, exampleFrom, exampleInput, forOp, parseExamples, renameExample, type SavedExample, saveExample,
} from "./examples";
import { bodyModel, type ExplorerModels, isModelNotEnabled, liveOp, modelOptionsFor, NO_MODELS, opTakesModel, setBodyModel } from "./live-model";
import { MethodChip } from "./method-chip";
import {
  applyExample, type Builder, buildRequest, describeResponse, initialBuilder, type Row, type ShownResponse, sizeText, statusWord,
} from "./request";
import { SnippetTabs } from "./snippet-tabs";
import { snippetsFor } from "./snippets";

// The API explorer for one endpoint (R10): a request builder (path, query, headers, JSON body), Try it with a pasted
// console key (kept in this component's state only: never stored, never in a cookie, never sent to a Server Action;
// fetch goes to this deployment's own path only), a response viewer, saved examples in this browser's localStorage, and
// copy-paste snippets. Endpoints marked docs-only (the schedulers') show the description, the example and snippets.

const EXAMPLES_EVENT = "watchpost:explorer-examples";
const MONO_FIELD = cn(fieldClass, "font-mono text-[12.5px]");

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EXAMPLES_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EXAMPLES_EVENT, cb);
  };
}
// localStorage can be missing, full or blocked (private windows): every access is guarded and the page works without it.
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(EXAMPLES_KEY);
  } catch {
    return null;
  }
}
function writeExamples(list: SavedExample[]): boolean {
  try {
    window.localStorage.setItem(EXAMPLES_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(EXAMPLES_EVENT));
    return true;
  } catch {
    return false;
  }
}

function ParamRow({ name, meta, children }: { name: ReactNode; meta: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-[720px]:contents">
      <span className="font-mono">{name}</span>
      <span className="text-ink-faint">{meta}</span>
      {children}
    </div>
  );
}

const metaOf = (p: ParamSpec | undefined, kind: string) => (p ? `${kind} · ${p.type}${p.required ? " · required" : ""}` : `${kind} · string`);

// models: the owner's enabled models and the console default, read by the page (server) and passed in as data. Bodies
// with a "model" field start with the live default instead of the spec's generic example.
export function Explorer({ opId, origin, models = NO_MODELS }: { opId: string; origin: string; models?: ExplorerModels }) {
  const base = opById(opId);
  if (!base) return null;
  return <ExplorerFor op={liveOp(base, models.defaultModel)} origin={origin} models={models} />;
}

function ExplorerFor({ op, origin, models }: { op: ApiOp; origin: string; models: ExplorerModels }) {
  const [key, setKey] = useState("");
  const [b, setB] = useState<Builder>(() => initialBuilder(op));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<ShownResponse | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [modelHint, setModelHint] = useState<string | null>(null);

  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const saved = useMemo(() => parseExamples(raw), [raw]);
  const mine = forOp(saved, op.id);
  const takesKey = needsKey(op);
  const takesModel = opTakesModel(op);
  const modelOptions = modelOptionsFor(op, models);
  const chosen = bodyModel(b.body);
  const notEnabled = resp !== null && isModelNotEnabled(resp);

  function chooseModel(id: string) {
    const r = setBodyModel(b.body, id);
    if (!r.ok) return setModelHint(r.error);
    setModelHint(null);
    setB((s) => ({ ...s, body: r.body }));
  }
  const snippets = useMemo(() => snippetsFor(op, origin, { path: b.path, query: b.query, headers: b.headers, body: b.body }), [op, origin, b]);

  const setRow = (group: "query" | "headers", i: number, patch: Partial<Row>) => setB((s) => ({ ...s, [group]: s[group].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRow = (group: "query" | "headers") => setB((s) => ({ ...s, [group]: [...s[group], { name: "", value: "" }] }));
  const removeRow = (group: "query" | "headers", i: number) => setB((s) => ({ ...s, [group]: s[group].filter((_, j) => j !== i) }));
  const declared = (group: "query" | "headers", row: Row) => op.params.some((p) => p.in === (group === "query" ? "query" : "header") && p.name === row.name);

  async function send() {
    const built = buildRequest(op, b, key, origin);
    if (!built.ok) {
      setError(built.error);
      setResp(null);
      return;
    }
    setError(null);
    setBusy(true);
    const t0 = performance.now();
    try {
      const { method, path, headers, body } = built.request;
      // Same origin only (a relative path), no cookies: the call is judged by the key alone, like any other client's.
      const res = await fetch(path, { method, headers, body, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(65_000) });
      const text = await res.text();
      const list: [string, string][] = [];
      res.headers.forEach((v, n) => list.push([n, v]));
      setResp(describeResponse({ status: res.status, statusText: res.statusText, headers: list, text, ms: performance.now() - t0 }));
    } catch (e) {
      setResp(null);
      setError(e instanceof DOMException && e.name === "TimeoutError" ? "No answer after 65 seconds." : "The request didn't go through. Check that this deployment is reachable and try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setB(initialBuilder(op));
    setError(null);
    setResp(null);
    setNaming(false);
    toast.success("Request reset to the starting values.");
  }

  function save() {
    const made = exampleFrom(op, b, name, crypto.randomUUID(), new Date());
    if (!made.ok) return void toast.error(made.error);
    const next = saveExample(saved, made.example);
    if (!next.ok) return void toast.error(next.error);
    if (!writeExamples(next.list)) return void toast.error("This browser blocked saving. Examples need localStorage.");
    setNaming(false);
    setName("");
    toast.success(`Saved “${made.example.name}” in this browser. Examples never keep the key.`);
  }

  function rename() {
    if (!renaming) return;
    const next = renameExample(saved, renaming.id, renaming.name);
    if (!next.ok) return void toast.error(next.error);
    if (!writeExamples(next.list)) return void toast.error("This browser blocked saving. Examples need localStorage.");
    setRenaming(null);
  }

  function remove(ex: SavedExample) {
    if (writeExamples(deleteExample(saved, ex.id))) toast.success(`Deleted “${ex.name}”.`);
    else toast.error("This browser blocked saving. Examples need localStorage.");
  }

  function load(label: string, input: Parameters<typeof applyExample>[1]) {
    setB(applyExample(op, input));
    setError(null);
    toast.success(`Loaded “${label}” into the request.`);
  }

  function format() {
    try {
      setB((s) => ({ ...s, body: JSON.stringify(JSON.parse(s.body), null, 2) }));
    } catch {
      toast.error("The body isn't valid JSON, so it can't be formatted.");
    }
  }

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(resp?.body ?? "");
      toast.success("Copied the response body.");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it.");
    }
  }

  const exampleResponse = op.response && (
    <details open={op.docsOnly} className="group">
      <summary className="cursor-pointer text-[13px] text-ink-soft">
        Example response · <span className="font-mono">{op.response.status} {op.response.contentType}</span>
      </summary>
      <p className="mb-1.5 mt-1.5 text-[13px] text-ink-soft">{op.response.description}</p>
      <pre className="m-0 overflow-x-auto rounded-md bg-code-bg px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-code-text">{op.response.example}</pre>
    </details>
  );

  const pathParams = op.params.filter((p) => p.in === "path");
  const hasRows = pathParams.length + b.query.length + b.headers.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card
        title={<span className="flex flex-wrap items-center gap-2"><MethodChip method={op.method} /><code className="font-mono text-[13px] font-normal [overflow-wrap:anywhere]">{op.path}</code></span>}
        meta={<span className="rounded-[4px] border border-line bg-surface-2 px-1.5 font-mono text-xs text-ink-soft">{op.scopeLabel}</span>}
      >
        <p className="font-medium">{op.summary}</p>
        {op.docsOnly ? (
          <div className="mt-3"><Banner tone="info" title="Docs only">{op.description}</Banner></div>
        ) : (
          <>
            <p className="mb-3.5 mt-0.5 text-[13px] text-ink-soft">{op.description}</p>
            {takesKey && (
              <Field id="api-key" label="Console API key" help={<>Kept in this tab&apos;s memory only. Never saved, never sent anywhere but <span className="font-mono">{origin}</span>.</>}>
                <input
                  id="api-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} className={MONO_FIELD} autoComplete="off" spellCheck={false}
                  data-1p-ignore data-lpignore="true" placeholder={`wb_… (needs ${op.scope === "any" ? "any scope" : op.scope})`}
                />
              </Field>
            )}
            {hasRows && (
              <div className="my-3 grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-3 text-[13px] min-[720px]:grid-cols-[150px_120px_minmax(0,1fr)] min-[720px]:items-center min-[720px]:gap-y-2">
                <span className="hidden text-xs text-ink-faint min-[720px]:block">Name</span>
                <span className="hidden text-xs text-ink-faint min-[720px]:block">In · type</span>
                <span className="hidden text-xs text-ink-faint min-[720px]:block">Value</span>
                {pathParams.map((p) => (
                  <ParamRow key={`path-${p.name}`} name={p.name} meta={metaOf(p, "path")}>
                    <input
                      className={MONO_FIELD} aria-label={`${p.name} (path)`} value={b.path[p.name] ?? ""} placeholder={p.example}
                      type={p.secret ? "password" : "text"} autoComplete="off" spellCheck={false} data-1p-ignore={p.secret ? true : undefined}
                      onChange={(e) => setB((s) => ({ ...s, path: { ...s.path, [p.name]: e.target.value } }))}
                    />
                  </ParamRow>
                ))}
                {(["query", "headers"] as const).flatMap((group) => b[group].map((row, i) => {
                  const spec = op.params.find((p) => p.in === (group === "query" ? "query" : "header") && p.name === row.name);
                  const fixed = declared(group, row);
                  const kind = group === "query" ? "query" : "header";
                  return (
                    <ParamRow
                      key={`${group}-${i}`}
                      name={fixed ? row.name : (
                        <span className="flex items-center gap-1">
                          <input className={MONO_FIELD} aria-label={`${kind} name`} value={row.name} placeholder={`${kind} name`} spellCheck={false} onChange={(e) => setRow(group, i, { name: e.target.value })} />
                        </span>
                      )}
                      meta={metaOf(spec, kind)}
                    >
                      <span className="flex items-center gap-1">
                        <input
                          className={MONO_FIELD} aria-label={`${row.name || kind} (${kind})`} value={row.value} placeholder={spec?.example} spellCheck={false}
                          onChange={(e) => setRow(group, i, { value: e.target.value })}
                        />
                        {!fixed && (
                          <button type="button" aria-label={`Remove this ${kind}`} title="Remove" onClick={() => removeRow(group, i)} className="grid size-8 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-hover">
                            <IconX size={15} aria-hidden />
                          </button>
                        )}
                      </span>
                    </ParamRow>
                  );
                }))}
              </div>
            )}
            <div className="mb-3 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => addRow("query")}><IconPlus size={14} aria-hidden />Query parameter</Button>
              <Button size="sm" variant="ghost" onClick={() => addRow("headers")}><IconPlus size={14} aria-hidden />Header</Button>
            </div>
            {takesModel && (modelOptions.length === 0 ? (
              <p className="mb-3 text-[13px] text-ink-soft">
                No model is on — switch one on under <Link href="/ai/models" className="text-brand">Models</Link>.
              </p>
            ) : (
              <div className="mb-3 flex flex-col gap-[5px]">
                <label htmlFor="api-model" className="text-[13px] font-medium">Model</label>
                <select
                  id="api-model" className={cn(MONO_FIELD, "max-w-[420px]")} value={chosen && modelOptions.some((m) => m.id === chosen) ? chosen : ""}
                  onChange={(e) => { if (e.target.value) chooseModel(e.target.value); }}
                >
                  {!(chosen && modelOptions.some((m) => m.id === chosen)) && <option value="">{chosen ? `${chosen} (not on)` : "Pick a model"}</option>}
                  {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.isDefault ? `${m.id} (default)` : m.id}</option>)}
                </select>
                {modelHint && <span role="alert" className="text-[12.5px] text-err">{modelHint}</span>}
              </div>
            ))}
            {op.body !== undefined && (
              <div className="mb-3.5 flex flex-col gap-[5px]">
                <div className="flex items-center gap-2">
                  <label htmlFor="api-body" className="text-[13px] font-medium">JSON body</label>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={format}>Format</Button>
                </div>
                <textarea
                  id="api-body" value={b.body} onChange={(e) => { setModelHint(null); setB((s) => ({ ...s, body: e.target.value })); }} spellCheck={false}
                  className={cn(MONO_FIELD, "min-h-[150px] resize-y")}
                />
                {op.bodyDescription && <span className="text-[12.5px] text-ink-soft">{op.bodyDescription}</span>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={send} disabled={busy}><IconPlayerPlay size={16} aria-hidden />{busy ? "Sending…" : "Send"}</Button>
              <Button onClick={() => setNaming((v) => !v)} aria-expanded={naming}>Save as example</Button>
              <Button variant="ghost" onClick={reset}>Reset</Button>
            </div>
            {naming && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  className={cn(fieldClass, "max-w-[280px]")} aria-label="Example name" placeholder="Example name" value={name} maxLength={60} autoFocus
                  onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setNaming(false); }}
                />
                <Button size="sm" variant="primary" onClick={save}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
                <span className="text-[12.5px] text-ink-soft">Stored in this browser only, without the key{pathParams.some((p) => p.secret) ? " or the token" : ""}.</span>
              </div>
            )}
          </>
        )}
      </Card>

      {!op.docsOnly && (
        <Card title="Response">
          <div aria-live="polite">
            {error && <p role="alert" className="mb-3 text-[13px] text-err">{error}</p>}
            {busy && !resp && <p className="text-ink-soft">Sending…</p>}
            {!resp && !busy && !error && (
              <EmptyState icon={IconSend} title="No request yet">Send to see the status, headers, timing and body.</EmptyState>
            )}
            {resp && (
              <>
                <div className="mb-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px]">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <StateIcon state={resp.tone} />{statusWord(resp.status, resp.statusText)}
                  </span>
                  <span className="font-mono text-ink-soft">{resp.ms} ms</span>
                  <span className="font-mono text-ink-soft">{sizeText(resp.bytes)}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={copyBody}><IconCopy size={14} aria-hidden />Copy body</Button>
                </div>
                {notEnabled && (
                  <p className="mb-2.5 text-[13px] text-ink-soft">
                    That model is off or unknown. Pick one from the Model list, or switch it on under <Link href="/ai/models" className="text-brand">Models</Link>.
                  </p>
                )}
                <details className="mb-2.5">
                  <summary className="cursor-pointer text-[13px] text-ink-soft">Response headers ({resp.headers.length})</summary>
                  <pre className="m-0 mt-1.5 overflow-x-auto rounded-md bg-code-bg px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-code-text">
                    {resp.headers.map(([n, v]) => `${n}: ${v}`).join("\n")}
                  </pre>
                </details>
                <pre className="m-0 max-h-[460px] overflow-auto rounded-md bg-code-bg px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-code-text">{resp.body || "(empty body)"}</pre>
                {resp.truncated && <p className="mt-1.5 text-[12.5px] text-ink-soft">Only the first 200,000 characters are shown.</p>}
              </>
            )}
          </div>
          <div className="mt-3.5">{exampleResponse}</div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
        {!op.docsOnly && (
          <Card title="Saved examples" meta={<span>this browser</span>}>
            <ul className="m-0 list-none p-0">
              {(op.examples ?? []).map((e) => (
                <li key={`spec-${e.name}`} className="flex items-center gap-2 border-b border-line py-[7px] last:border-0">
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{e.name}</span>
                  <span className="text-xs text-ink-faint">from the spec</span>
                  <Button size="sm" variant="ghost" onClick={() => load(e.name, e)}>Load</Button>
                </li>
              ))}
              {mine.map((e) => (
                <li key={e.id} className="flex items-center gap-2 border-b border-line py-[7px] last:border-0">
                  {renaming?.id === e.id ? (
                    <>
                      <input
                        className={cn(fieldClass, "min-w-0 flex-1")} aria-label="New name" value={renaming.name} maxLength={60} autoFocus
                        onChange={(ev) => setRenaming({ id: e.id, name: ev.target.value })} onKeyDown={(ev) => { if (ev.key === "Enter") rename(); if (ev.key === "Escape") setRenaming(null); }}
                      />
                      <Button size="sm" variant="primary" onClick={rename}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{e.name}</span>
                      <Button size="sm" variant="ghost" onClick={() => load(e.name, exampleInput(e))}>Load</Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: e.id, name: e.name })}>Rename</Button>
                      <button type="button" aria-label={`Delete ${e.name}`} title="Delete" onClick={() => remove(e)} className="grid size-8 place-items-center rounded-md text-ink-soft hover:bg-hover">
                        <IconTrash size={15} aria-hidden />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {!(op.examples?.length) && !mine.length && <p className="m-0 text-[13px] text-ink-soft">No saved examples yet. Fill in a request and use Save as example.</p>}
          </Card>
        )}
        <Card title="Snippets" meta={<span>{secretNote(op)}</span>} className={op.docsOnly ? "min-[1100px]:col-span-2" : undefined}>
          <SnippetTabs snippets={snippets} />
        </Card>
      </div>
      {op.docsOnly && <Card title="Example response">{exampleResponse}</Card>}
    </div>
  );
}

// What the snippets read instead of a secret.
function secretNote(op: ApiOp): string {
  const env = bearerEnvOf(op);
  if (env) return `the secret comes from $${env}`;
  return op.access === "token" ? "the token comes from $HEARTBEAT_TOKEN" : "no key needed";
}
