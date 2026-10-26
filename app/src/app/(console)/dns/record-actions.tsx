"use client";

import { IconSitemap } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useMask } from "@/components/alias";
import { Banner, Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { ProviderActionButton } from "@/components/provider-action";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { canEdit, canProxy, type Change, planEdit, type RecordValues, TTL_CHOICES, validateEdit } from "@/lib/network/dns-edit";
import { pointsToVercel } from "@/lib/network/rules";
import { confirmResult } from "@/lib/view/action-result";
import { ttlText } from "@/lib/view/network";
import { editDnsRecordAction } from "./actions";

// Stage 6 slice 2 (plan B2/B3): a DNS record's actions. The Owner gets Set DNS only (a proxied record that points to
// Vercel, mockup dns()) and Edit (A, AAAA, CNAME, TXT: the form, then a review of every change as Now → After, then
// Save record). Operators see both disabled ("Owner only"). Titles, the review and the toast are masked in screenshot
// mode; the form's inputs keep the real values (masking is display only).

export type DnsRow = { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean; comment: string | null };

const OWNER_ONLY = "Owner only";
const TYPES_ONLY = "Only A, AAAA, CNAME and TXT records can be edited here.";

function Disabled({ label, why }: { label: string; why: string }) {
  return (
    <span title={why} className="inline-flex">
      <Button size="sm" disabled aria-label={`${label}: ${why}`}>{label}</Button>
    </span>
  );
}

// The mockup's Now / After list, as spans: the dialog's description is a paragraph, so no <dl> inside it.
function NowAfter({ rows }: { rows: { label: string; before: string; after: string }[] }) {
  return (
    <span className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1.5 text-ink">
      {rows.map((r) => (
        <span key={r.label} className="contents">
          <span className="text-ink-soft">{r.label}</span>
          <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{r.before}</span>
          <span aria-hidden className="text-ink-faint">→</span>
          <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{r.after}</span>
        </span>
      ))}
    </span>
  );
}

const valuesOf = (r: DnsRow): RecordValues => ({ content: r.content, ttl: r.ttl, proxied: r.proxied });

export function DnsRecordActions({ zoneId, r, owner, vercel }: { zoneId: string; r: DnsRow; owner: boolean; vercel: boolean }) {
  const mask = useMask();
  const dnsOnly = r.proxied && vercel;
  if (!owner) {
    return <div className="flex gap-1.5">{dnsOnly && <Disabled label="Set DNS only" why={OWNER_ONLY} />}<Disabled label="Edit" why={OWNER_ONLY} /></div>;
  }
  return (
    <div className="flex gap-1.5">
      {dnsOnly && <SetDnsOnlyButton zoneId={zoneId} r={r} />}
      {canEdit(r.type) ? <EditRecordDialog zoneId={zoneId} r={r} mask={mask} /> : <Disabled label="Edit" why={TYPES_ONLY} />}
    </div>
  );
}

// Set DNS only: the mockup's confirmFor("Set DNS only") copy.
export function SetDnsOnlyButton({ zoneId, r }: { zoneId: string; r: DnsRow }) {
  const mask = useMask();
  const toVercel = pointsToVercel(r);
  return (
    <ProviderActionButton
      label="Set DNS only"
      title={mask("text", `Set ${r.name} to DNS only?`)}
      body={<NowAfter rows={[{ label: "Proxy", before: "Proxied through Cloudflare", after: toVercel ? "DNS only, straight to Vercel" : "DNS only, straight to the origin" }]} />}
      cta="Set DNS only"
      run={() => editDnsRecordAction(zoneId, r.id, valuesOf(r), { ...valuesOf(r), proxied: false })}
    />
  );
}

const LABEL: Record<Change["field"], string> = { content: "Content", ttl: "TTL", proxied: "Proxy" };

function EditRecordDialog({ zoneId, r, mask }: { zoneId: string; r: DnsRow; mask: ReturnType<typeof useMask> }) {
  const [open, setOpen] = useState(false);
  useHoldRefresh(open);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>Edit</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        {open && <EditForm zoneId={zoneId} r={r} mask={mask} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

// Its own component so the form state starts fresh each time the dialog opens.
function EditForm({ zoneId, r, mask, onDone }: { zoneId: string; r: DnsRow; mask: ReturnType<typeof useMask>; onDone: () => void }) {
  const [content, setContent] = useState(r.content);
  const [ttl, setTtl] = useState(r.ttl);
  const [proxied, setProxied] = useState(r.proxied);
  const [review, setReview] = useState<Change[] | null>(null);
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  const [pending, start] = useTransition();
  const wanted: RecordValues = { content, ttl, proxied };
  const proxiable = canProxy(r.type);
  const ttls = (TTL_CHOICES as readonly number[]).includes(r.ttl) ? TTL_CHOICES : [...TTL_CHOICES, r.ttl].sort((a, b) => a - b);
  const warnVercel = proxied && pointsToVercel({ type: r.type, content });

  function toReview() {
    const v = validateEdit(r, wanted);
    if (!v.ok) return setError({ field: v.field, text: v.error });
    const p = planEdit(r, wanted);
    if (!p.ok) return setError({ field: "form", text: p.error });
    setError(null);
    setReview(p.changes);
  }

  function save() {
    start(async () => {
      try {
        const res = confirmResult(await editDnsRecordAction(zoneId, r.id, valuesOf(r), wanted), (t) => mask("text", t));
        if (res.ok) {
          toast.success(res.message);
          onDone();
        } else {
          toast.error(res.message);
        }
      } catch {
        toast.error("Watchbell didn't answer. Check that it's still running, then try again.");
      }
    });
  }

  const fieldError = (f: string) => (error?.field === f ? error.text : undefined);
  return (
    <>
      <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconSitemap size={19} /></span>
        <div>
          <DialogTitle className="text-base">{mask("text", review ? `Save ${r.type} record ${r.name}?` : `Edit ${r.type} record ${r.name}`)}</DialogTitle>
          <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
            {review
              ? <>Cloudflare changes this record now. Nothing else in the zone changes, and nothing is deleted.<NowAfter rows={review.map((c) => ({ label: LABEL[c.field], before: mask("text", c.before), after: mask("text", c.after) }))} /></>
              : "Type and name stay as they are. Watchbell never creates or deletes records here."}
          </DialogDescription>
        </div>
      </div>
      {!review && (
        <div className="px-[18px] pt-1.5">
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <Field id="dns-type" label="Type"><input id="dns-type" className={fieldClass} value={r.type} readOnly disabled /></Field>
            <Field id="dns-name" label="Name"><input id="dns-name" className={fieldClass} value={mask("text", r.name)} readOnly disabled /></Field>
          </div>
          <Field id="dns-content" label="Content" error={fieldError("content")}
            help={r.type === "CNAME" || r.type === "A" ? "For Vercel, copy the value shown on the project's Domains page." : undefined}>
            <input id="dns-content" className={fieldClass} value={content} spellCheck={false} autoComplete="off" maxLength={2048}
              aria-invalid={!!fieldError("content")} onChange={(e) => setContent(e.target.value)} />
          </Field>
          <Field id="dns-ttl" label="TTL" error={fieldError("ttl")} help={proxied ? "A proxied record always uses Auto." : undefined}>
            <select id="dns-ttl" className={fieldClass} value={proxied ? 1 : ttl} disabled={proxied} onChange={(e) => setTtl(Number(e.target.value))}>
              {ttls.map((t) => <option key={t} value={t}>{ttlText(t)}</option>)}
            </select>
          </Field>
          {proxiable && (
            <div className="mb-3.5 flex flex-col gap-[5px]">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-brand" checked={proxied} onChange={(e) => setProxied(e.target.checked)} />
                Proxied through Cloudflare (orange cloud)
              </label>
              {fieldError("proxied") && <span className="text-[12.5px] text-err" role="alert">{fieldError("proxied")}</span>}
            </div>
          )}
          {warnVercel && (
            <div className="mb-3.5"><Banner tone="warning" title="Vercel recommends DNS only here">Proxying a record that points to Vercel can stop its certificate from renewing.</Banner></div>
          )}
          {error?.field === "form" && <p className="mb-3 text-[12.5px] text-err" role="alert">{error.text}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
        {review
          ? <>
            <Button onClick={() => setReview(null)} disabled={pending}>Back</Button>
            <Button variant="primary" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save record"}</Button>
          </>
          : <>
            <Button onClick={onDone}>Keep as is</Button>
            <Button variant="primary" onClick={toReview}>Review</Button>
          </>}
      </div>
    </>
  );
}
