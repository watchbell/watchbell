"use client";

import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { Masked, MaskedText } from "@/components/alias";
import { Button, buttonClass, Card, fieldClass, Tag } from "@/components/kit";
import { ResourceBadge } from "@/components/resource";
import { td, tableClass, TableHead } from "@/components/table";
import type { StatusPageSettings } from "@/lib/data/public-status-db";
import { ANNOUNCEMENT_MAX, badgeKey, NAME_MAX, parseStatusPageForm, TITLE_MAX } from "@/lib/public-status";
import { cn } from "@/lib/utils";
import { saveStatusPageSettings } from "./status-page-actions";

// Mockup settings() → Status page. Owner only (the Settings page's gate and the action's). A monitor is on the public
// page only when ticked, under the public name typed here: nothing is pre-filled from the app, its address or its
// database, so a real name reaches the public page only when the owner types it (B1).
const ROW = "grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-b border-line py-3 last:border-b-0 max-[720px]:grid-cols-1 max-[720px]:gap-1";
const codeBox = "min-w-0 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-sunken px-2 py-1.5 font-mono text-[12.5px]";

type Row = StatusPageSettings["monitors"][number];

function FormRow({ id, label, help, error, children }: { id?: string; label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <label htmlFor={id} className="font-medium">
        {label}
        {help && <span className="mt-0.5 block text-[12.5px] font-normal text-ink-soft">{help}</span>}
      </label>
      <div className="min-w-0">
        {children}
        {error && <span className="mt-1 block text-[12.5px] text-err" role="alert">{error}</span>}
      </div>
    </div>
  );
}

export function StatusPageTab({ settings, siteUrl }: { settings: StatusPageSettings; siteUrl: string }) {
  const saved = settings.page;
  const [published, setPublished] = useState(saved?.published ?? false);
  const [slug, setSlug] = useState(saved?.slug ?? "");
  const [title, setTitle] = useState(saved?.title ?? "");
  const [announcement, setAnnouncement] = useState(saved?.announcement ?? "");
  const [rows, setRows] = useState<Row[]>(settings.monitors);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const origin = siteUrl.replace(/\/+$/, "");
  const address = `${origin}/s/${slug || "{slug}"}`;
  const firstShown = rows.find((r) => r.shown && r.displayName.trim());
  const badgeUrl = `${address}/badge/${firstShown ? badgeKey(firstShown.displayName) : "{name}"}.svg`;
  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  function save() {
    const form = {
      slug, title, announcement, published,
      monitors: rows.filter((r) => r.shown).map((r) => ({ monitorId: r.id, displayName: r.displayName })),
    };
    const p = parseStatusPageForm(form);
    if (!p.ok) {
      setErrors(p.fieldErrors);
      return;
    }
    setErrors({});
    start(async () => {
      const r = await saveStatusPageSettings(form);
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Status page saved. It updates within a minute.");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Public status page">
        <FormRow
          id="sp-published"
          label="Status page"
          help="The console's only page without sign-in. It shows the names you choose, the current state, 90-day bars and maintenance. Never addresses, error text or provider names."
        >
          <label className="inline-flex items-center gap-1.5">
            <input id="sp-published" type="checkbox" className="size-4 accent-brand" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            Published
          </label>
        </FormRow>
        <FormRow id="sp-slug" label="Address" help="3–40 lowercase letters, digits or dashes." error={errors.slug}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="sp-slug" className={cn(fieldClass, "max-w-[200px] font-mono text-[12.5px]")} value={slug} maxLength={40} placeholder="my-apps"
              autoComplete="off" spellCheck={false} aria-invalid={!!errors.slug} onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
            <code className={codeBox}><MaskedText text={address} /></code>
            {saved?.published && (
              <a className={buttonClass({ size: "sm" })} href={`/s/${saved.slug}`} target="_blank" rel="noopener noreferrer">Preview</a>
            )}
          </div>
        </FormRow>
        <FormRow id="sp-title" label="Title" error={errors.title}>
          <input id="sp-title" className={cn(fieldClass, "max-w-[320px]")} value={title} maxLength={TITLE_MAX} placeholder="e.g. My apps" aria-invalid={!!errors.title} onChange={(e) => setTitle(e.target.value)} />
        </FormRow>
        <FormRow id="sp-note" label="Announcement" help="Optional. Shown at the top until you clear it.">
          <input
            id="sp-note" className={cn(fieldClass, "max-w-[420px]")} value={announcement} maxLength={ANNOUNCEMENT_MAX}
            placeholder="e.g. Moving to a new database tonight" onChange={(e) => setAnnouncement(e.target.value)}
          />
        </FormRow>
        <FormRow label="Badges" help="Uptime badge per monitor, for READMEs. Cached 5 minutes.">
          <code className={cn(codeBox, "block")}><MaskedText text={badgeUrl} /></code>
        </FormRow>
      </Card>
      <Card title="Monitors on the page" flush meta={`${rows.filter((r) => r.shown).length} shown`}>
        <p className="px-[18px] pb-2.5 text-[12.5px] text-ink-soft">
          Visitors see only the public name, never the app, its address or its database. The page lists them in this order.
        </p>
        {errors.monitors && <p className="px-[18px] pb-2.5 text-[12.5px] text-err" role="alert">{errors.monitors}</p>}
        {rows.length === 0 ? (
          <p className="px-[18px] pb-4 text-ink-soft">No monitors yet. Add one on the Uptime page first.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <TableHead head={["Show", "Monitor", "Public name"]} />
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={cn(td, "w-[60px]")}>
                      <input
                        type="checkbox" className="size-4 accent-brand" checked={r.shown} aria-label={`Show ${r.path} on the public page`}
                        onChange={(e) => setRow(r.id, { shown: e.target.checked })}
                      />
                    </td>
                    <td className={td}>
                      <span className="inline-flex items-center gap-[7px]">
                        <ResourceBadge kind="mon" />
                        <span><Masked kind="app" real={r.appName} /><span className="text-ink-faint">{r.kind === "heartbeat" ? ` · ${r.path}` : r.path}</span></span>
                        {r.kind === "heartbeat" && <Tag>Heartbeat</Tag>}
                      </span>
                    </td>
                    <td className={td}>
                      <input
                        className={cn(fieldClass, "w-[220px]")} value={r.displayName} maxLength={NAME_MAX} placeholder={r.shown ? "Public name" : ""}
                        aria-label="Public name" disabled={!r.shown} onChange={(e) => setRow(r.id, { displayName: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-[18px] py-3">
          <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        </div>
      </Card>
    </div>
  );
}
