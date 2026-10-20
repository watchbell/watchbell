"use client";

import { IconCopy } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { approveCreateAction, rejectCreateAction } from "@/app/(console)/create/actions";
import { useMask, usePrivacy } from "@/components/alias";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Banner, Button, Card, Field, fieldClass, Tag } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cantRemove, type CreateRequestView, PROVIDER_NAME, TYPE_LABEL } from "@/lib/create/types";
import { splitRequests } from "@/lib/create/split";
import { cn } from "@/lib/utils";

// Stage 6 create requests: the "Waiting for approval" list (each create page and Overview). The Owner approves by typing
// the new resource's name; the server checks aal2, re-checks the free tier live and makes one create call. A Supabase
// project's database password comes back once, is shown here with a copy button, and is gone when the dialog closes.
// Everything named is masked in screenshot mode.

const STATUS: Record<CreateRequestView["status"], string> = {
  requested: "Waiting for approval", approved: "Approved", running: "Creating…", done: "Created", failed: "Failed", rejected: "Rejected", expired: "Expired",
};

export function CreateRequestList({ items, owner, focus, title = "Waiting for approval" }: { items: CreateRequestView[]; owner: boolean; focus?: string | null; title?: string }) {
  const { pending, finished } = splitRequests(items);
  if (!pending.length && !finished.length) return null;
  const waiting = pending.filter((i) => i.status === "requested").length;
  return (
    <>
      {pending.length > 0 && (
        <Card title={title} meta={waiting ? `${waiting} waiting` : undefined} flush>
          <RequestRows items={pending} owner={owner} focus={focus} />
        </Card>
      )}
      {finished.length > 0 && (
        <Card title="Recent requests" flush>
          <RequestRows items={finished} owner={false} focus={focus} quiet />
        </Card>
      )}
    </>
  );
}

function RequestRows({ items, owner, focus, quiet }: { items: CreateRequestView[]; owner: boolean; focus?: string | null; quiet?: boolean }) {
  const mask = useMask();
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => (
        <li key={i.id} id={`create-${i.id}`} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-[18px] py-2.5", quiet && "py-2 text-[13px]", focus === i.id && "bg-brand-soft")}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <b className={cn("font-medium", quiet && "text-ink-soft")}>{TYPE_LABEL[i.type]}</b>
              <Tag>{PROVIDER_NAME[i.type]}</Tag>
              <span className={cn("text-[12.5px]", i.status === "failed" ? "text-err" : "text-ink-soft")}>{STATUS[i.status]}</span>
            </div>
            <p className="font-mono text-[12.5px] text-ink-soft [overflow-wrap:anywhere]">{mask("text", i.summary)}</p>
            {i.status === "requested" && <p className="text-[12px] text-ink-faint">{i.mine ? "You asked" : "Another member asked"} · expires {new Date(i.expiresAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>}
            {i.error && i.status !== "requested" && <p className="text-[12.5px] text-err">{mask("text", i.error)}</p>}
            {i.result?.id && i.status === "done" && <p className="text-[12px] text-ink-faint">Created: <span className="font-mono">{mask("text", i.result.id)}</span>{i.result.note === "firebase-pending" ? " · Firebase still needs adding in the Firebase console" : ""}</p>}
          </div>
          {owner && i.status === "requested" && (
            <div className="flex gap-1.5">
              <RejectButton item={i} />
              <ApproveButton item={i} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function RejectButton({ item }: { item: CreateRequestView }) {
  return (
    <ConfirmDialog
      trigger={<Button size="sm">Reject</Button>}
      title={`Reject this ${TYPE_LABEL[item.type]}?`}
      body="Nothing is created. The person who asked can ask again."
      cta="Reject"
      onConfirm={async () => {
        const r = await rejectCreateAction(item.id);
        return r.ok ? { ok: true, message: r.message ?? "Rejected." } : { ok: false, message: r.error };
      }}
    />
  );
}

function ApproveButton({ item }: { item: CreateRequestView }) {
  const [open, setOpen] = useState(false);
  useHoldRefresh(open);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="primary" />}>Approve…</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        {open && <ApproveForm item={item} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ApproveForm({ item, onDone }: { item: CreateRequestView; onDone: () => void }) {
  const mask = useMask();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function approve() {
    start(async () => {
      try {
        const r = await approveCreateAction(item.id, typed);
        if (!r.ok) return setError(mask("text", r.error));
        setError(null);
        if (r.data?.secret) {
          setSecret(r.data.secret);
          setDone(mask("text", r.message ?? "Created."));
        } else {
          toast.success(mask("text", r.message ?? "Created."));
          onDone();
        }
      } catch {
        setError("Something went wrong. Check the provider's dashboard before trying again.");
      }
    });
  }

  if (secret) {
    return (
      <>
        <div className="px-[18px] pb-2 pt-4">
          <DialogTitle className="text-base">Copy the database password now</DialogTitle>
          <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">{done} It is shown only here, only once.</DialogDescription>
        </div>
        <div className="px-[18px] pt-1.5">
          <SecretBox value={secret} />
          <div className="mb-3"><Banner tone="warning" title="The console doesn&apos;t keep it">Save it in your password manager. If it&apos;s lost, reset it in Supabase → Project settings → Database.</Banner></div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
          <Button variant="primary" onClick={() => { setSecret(null); onDone(); }}>I&apos;ve saved it</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="px-[18px] pb-2 pt-4">
        <DialogTitle className="text-base">{mask("text", `Create ${TYPE_LABEL[item.type]} ${item.confirmName}?`)}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
          The console checks the free tier at {PROVIDER_NAME[item.type]} again now, then makes one create call. {cantRemove(item.type)}
        </DialogDescription>
      </div>
      <div className="px-[18px] pt-2">
        <p className="mb-3 rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] [overflow-wrap:anywhere]">{mask("text", item.summary)}</p>
        <Field id={`ap-${item.id}`} label={<>Type <span className="font-mono">{mask("text", item.confirmName)}</span> to approve</>} error={error ?? undefined}>
          <input id={`ap-${item.id}`} className={fieldClass} value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button onClick={onDone} disabled={pending}>Cancel</Button>
        <Button variant="primary" onClick={approve} disabled={pending || typed.trim() !== item.confirmName}>{pending ? "Checking and creating…" : "Approve and create"}</Button>
      </div>
    </>
  );
}

function SecretBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const { shot } = usePrivacy();
  const [show, setShow] = useState(false);
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-line-strong bg-sunken px-3 py-2">
      {shot && !show
        ? <button type="button" className="min-w-0 flex-1 text-left text-[13px] text-ink-soft" onClick={() => setShow(true)}>Hidden in screenshot mode. Click to show it.</button>
        : <code className="min-w-0 flex-1 select-all font-mono text-[13px] [overflow-wrap:anywhere]">{value}</code>}
      <Button size="sm" onClick={() => {
        navigator.clipboard.writeText(value).then(() => setCopied(true), () => toast.error("Copy didn't work; select the text and copy it."));
      }}><IconCopy size={14} aria-hidden className="mr-1 inline" />{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}
