"use client";

import { IconCopy, IconDatabaseCog } from "@tabler/icons-react";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { AutoAccess } from "@/lib/providers/supabase-sql";
import type { SqlProvider } from "@/lib/sql/dsn";
import { connectionHint, NEON_NOTE, RLS_NOTE, RLS_POLICY_SQL, RO_ROLE, roleSql } from "@/lib/sql/role-sql";
import { WAKE_TEXT } from "@/lib/sql/targets";
import { createSqlAccessAutoAction, deleteSqlAccess, setSqlAccess, sqlAutoStatusAction } from "./actions";

// Stage 9 slice 2: Add / Replace / Remove a database's read-only "SQL access" connection string (owner only). The
// field is a password input, cleared on every open and after a save; the page never receives a stored string back.
// Slice 2b: for Supabase, "Set up automatically (read-only)" when the project's token can run SQL (checked on open); the
// server creates the role, checks it and saves it, and the generated password never reaches this page.

type Props = { id: string; alias: string; provider: SqlProvider; connected: boolean };

type AutoState = { phase: "idle" | "checking" } | { phase: "done"; access: AutoAccess } | { phase: "error"; error: string };

const autoPermText = (a: Exclude<AutoAccess, { can: true }>) => a.reason === "scope"
  ? `This project's token can't create the role (missing ${a.missing.join(", ")}). Automatic setup needs a token with Database: Read-write and Connection pooling: Read; replace it on Connections, or follow the steps below.`
  : `Automatic setup isn't available right now: ${a.error} Follow the steps below.`;

function CopyBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      {/* Wraps long statements (the dialog's grid column can shrink; owner 20 Oct: the SQL pushed everything past the edge). */}
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-sunken py-2 pl-3 pr-20 font-mono text-[12px] leading-relaxed text-ink">{text}</pre>
      <Button size="sm" variant="ghost" className="absolute right-1.5 top-1.5" aria-label="Copy SQL"
        onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"))}>
        <IconCopy size={14} /> Copy
      </Button>
    </div>
  );
}

export function SqlAccessDialog({ id, alias, provider, connected }: Props) {
  const [open, setOpen] = useState(false);
  const [dsn, setDsn] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [wake, setWake] = useState(false);
  const [pending, start] = useTransition();
  const [auto, setAuto] = useState<AutoState>({ phase: "idle" });
  const [autoError, setAutoError] = useState<string | undefined>();
  useHoldRefresh(open);

  const check = useRef(0);

  // Supabase only: ask once per open whether the token can run the automatic setup. A late answer from an earlier
  // open is ignored.
  function checkAuto() {
    const n = ++check.current;
    setAuto({ phase: "checking" });
    sqlAutoStatusAction(id).then(
      (r) => { if (check.current === n) setAuto(r.ok && r.data ? { phase: "done", access: r.data } : { phase: "error", error: r.ok ? "No answer." : r.error }); },
      () => { if (check.current === n) setAuto({ phase: "error", error: "Couldn't check this project's token." }); },
    );
  }

  function createAuto() {
    setAutoError(undefined);
    start(async () => {
      try {
        const r = await createSqlAccessAutoAction(id);
        if (!r.ok) {
          setAutoError(r.error);
          return;
        }
        toast.success(`SQL access created for ${alias}`, { description: `Read-only role ${RO_ROLE}, checked and saved. Open Databases → SQL console to run a query.` });
        setOpen(false);
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }

  function show(next: boolean) {
    if (pending) return;
    setDsn("");
    setError(undefined);
    setWake(false);
    setAutoError(undefined);
    check.current++;
    setAuto({ phase: "idle" });
    setOpen(next);
    if (next && provider === "supabase") checkAuto();
  }

  function save(confirmWake: boolean) {
    start(async () => {
      try {
        const r = await setSqlAccess(id, dsn, confirmWake);
        if (!r.ok) {
          if (r.data?.needsWake) {
            setWake(true);
            setError(undefined);
            return;
          }
          setError(r.fieldErrors?.dsn ?? r.error);
          return;
        }
        toast.success(`SQL access saved for ${alias}`, { description: "Open Databases → SQL console to run a query." });
        setDsn("");
        setOpen(false);
      } catch {
        toast.error("Something went wrong. Try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={show}>
      <DialogTrigger render={<Button size="sm">{connected ? "Replace SQL access" : "Add SQL access"}</Button>} />
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconDatabaseCog size={19} /></span>
          <div>
            <DialogTitle className="text-base">{connected ? "Replace" : "Add"} SQL access for {alias}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              The SQL console connects with a read-only Postgres role you create. The console never reads your app&apos;s own secrets.
            </DialogDescription>
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save(false); }}>
          <div className="max-h-[65vh] overflow-y-auto px-[18px] pt-2 text-[13px] text-ink-soft">
            {provider === "supabase" && (
              <div className="mb-3 rounded-md border border-line px-3 py-2.5">
                {auto.phase === "done" && auto.access.can ? (
                  <>
                    <p className="text-ink">
                      Watchbell can set this up for you: it creates (or resets) the role <span className="font-mono">{RO_ROLE}</span> with SELECT only,
                      checks that it can&apos;t write, and saves the pooler string encrypted. The password is generated on the server and never shown.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <Button type="button" variant="primary" size="sm" disabled={pending} onClick={createAuto}>
                        {pending ? "Setting up…" : "Set up automatically (read-only)"}
                      </Button>
                      <span className="text-[12px] text-ink-faint">Or do it by hand below.</span>
                    </div>
                    {autoError && <p className="mt-2 text-[12.5px] text-err" role="alert">{autoError}</p>}
                  </>
                ) : auto.phase === "done" && !auto.access.can ? (
                  <p>{autoPermText(auto.access)}</p>
                ) : auto.phase === "error" ? (
                  <p>Automatic setup couldn&apos;t be checked: {auto.error} Follow the steps below.</p>
                ) : (
                  <p className="text-ink-faint">Checking whether this project&apos;s token can set the role up…</p>
                )}
              </div>
            )}
            {provider === "neon" && <p className="mb-2 text-[12.5px]">{NEON_NOTE}</p>}
            <ol className="mb-3 list-decimal space-y-2 pl-5">
              <li>
                Create the role. Replace the password first.
                <div className="mt-1.5"><CopyBlock text={roleSql(provider)} /></div>
                {provider === "supabase" && (
                  <>
                    <p className="mt-1.5 text-[12.5px]">{RLS_NOTE}</p>
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[12.5px] text-ink">Optional: a SELECT-only policy on every table with RLS (never run for you)</summary>
                      <div className="mt-1.5"><CopyBlock text={RLS_POLICY_SQL} /></div>
                    </details>
                  </>
                )}
              </li>
              <li>Build its connection string: <span className="break-all font-mono text-[12px] text-ink">{connectionHint(provider)}</span></li>
              <li>Paste it below. Saving connects once and checks that the role can&apos;t write; a role that can is refused. The string is stored encrypted and never shown again.</li>
            </ol>
            <Field id={`dsn-${id}`} label="Read-only connection string" error={error}>
              <input id={`dsn-${id}`} type="password" className={`${fieldClass} font-mono`} autoComplete="off" spellCheck={false}
                placeholder="postgresql://watchpost_ro…" value={dsn} onChange={(e) => { setDsn(e.target.value); setError(undefined); setWake(false); }} />
            </Field>
            {wake && (
              <div className="mb-3 rounded-md border border-warn-icon/35 bg-warn-soft px-3 py-2 text-ink" role="alert">
                Saving tests the connection once. {WAKE_TEXT}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
            <Button type="button" onClick={() => show(false)} disabled={pending}>Cancel</Button>
            {wake
              ? <Button type="button" variant="primary" disabled={pending || !dsn.trim()} onClick={() => save(true)}>{pending ? "Testing…" : "Wake it and save"}</Button>
              : <Button type="submit" variant="primary" disabled={pending || !dsn.trim()}>{pending ? "Testing…" : connected ? "Test and replace" : "Test and save"}</Button>}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SqlAccessButtons(props: Props) {
  return (
    <span className="inline-flex gap-1.5">
      <SqlAccessDialog {...props} />
      {props.connected && (
        <ConfirmDialog
          trigger={<Button size="sm" variant="ghost">Remove</Button>} danger title={`Remove SQL access for ${props.alias}?`} cta="Remove"
          body="The console deletes the stored connection string. Drop the role in the database too: drop owned by watchpost_ro; drop role watchpost_ro;"
          onConfirm={async () => {
            const r = await deleteSqlAccess(props.id);
            return r.ok ? { ok: true, message: `SQL access removed for ${props.alias}.` } : { ok: false, message: r.error };
          }}
        />
      )}
    </span>
  );
}
