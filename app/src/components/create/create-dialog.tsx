"use client";

import { IconPlus } from "@tabler/icons-react";
import { ENV_COPY } from "@/lib/copy/edition";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { createOptionsAction, disconnectGoogleCreate, requestCreateAction, startGoogleCreateConnect } from "@/app/(console)/create/actions";
import { useMask } from "@/components/alias";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Banner, Button, Field, fieldClass } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CONNECT_EXPLAINER } from "@/lib/create/connect-text";
import { type CreateOptions, type CreateType, PROVIDER_NAME, TYPE_LABEL } from "@/lib/create/types";
import { SUPABASE_REGIONS, validateDns, validateFirebase, validateNeon, validateSupabase } from "@/lib/create/validate";
import { AUTO_TTL, TTL_CHOICES } from "@/lib/network/dns-edit";
import { ttlText } from "@/lib/view/network";

// Stage 6 create requests: the "Add record" / "New branch" / "New project" dialog. It only ASKS: the request then waits
// for the Owner's approval (with the authenticator code) in the waiting list, which re-checks and creates. The dialog
// reads its live choices when it opens. Names in the title and toasts are masked in screenshot mode.

const NOTE: Record<CreateType, string> = {
  dns_record: "The name must be new in this zone. Proxied is off unless you turn it on.",
  neon_branch: "The branch is created without a compute, so it uses no CU-hours until you wake it. Waking it later uses CU-hours (100 a month per project on the free plan).",
  supabase_project: "Only an organization on the free plan is allowed. The database password is generated when the Owner approves and shown once.",
  firebase_project: "A Google Cloud project without a billing account (the free Spark plan), then Firebase is added to it.",
};

export function CreateButton({ type, target, targetName, label }: { type: CreateType; target: string; targetName: string; label: string }) {
  const [open, setOpen] = useState(false);
  useHoldRefresh(open);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}><IconPlus size={15} aria-hidden className="-ml-0.5 mr-1 inline" />{label}</DialogTrigger>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]" showCloseButton={false}>
        {open && <CreateForm type={type} target={target} targetName={targetName} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ type, target, targetName, onDone }: { type: CreateType; target: string; targetName: string; onDone: () => void }) {
  const mask = useMask();
  const [opts, setOpts] = useState<CreateOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [account, setAccount] = useState(target);
  const [v, setV] = useState<Record<string, string | number | boolean>>({ type: "CNAME", ttl: AUTO_TTL, proxied: false, region: "ap-southeast-1" });
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: string, val: string | number | boolean) => setV((x) => ({ ...x, [k]: val }));

  useEffect(() => {
    let live = true;
    createOptionsAction(type, account).then((r) => {
      if (!live) return;
      if (r.ok && r.data) {
        setOpts(r.data);
        if (r.data.type === "neon_branch") {
          const first = (r.data.branches.find((b) => b.isDefault) ?? r.data.branches[0])?.id ?? "";
          setV((x) => ({ ...x, parentId: x.parentId ?? first }));
        }
        if (r.data.type === "supabase_project") {
          if (r.data.accountId && r.data.accountId !== account) setAccount(r.data.accountId);
          const free = r.data.orgs.find((o) => o.allowed);
          if (free) setV((x) => ({ ...x, orgSlug: free.slug }));
        }
      } else setLoadError(r.ok ? "Something went wrong." : r.error);
    }).catch(() => live && setLoadError("Couldn't load the choices. Try again."));
    return () => { live = false; };
  }, [type, account]);

  function check(): boolean {
    const r = type === "dns_record" ? validateDns(v, targetName)
      : type === "neon_branch" ? validateNeon(v, targetName)
        : type === "supabase_project" ? validateSupabase(v)
          : validateFirebase(v);
    if (!r.ok) setError({ field: r.field, text: r.error });
    else setError(null);
    return r.ok;
  }

  function submit() {
    if (!check()) return;
    start(async () => {
      try {
        const r = await requestCreateAction(type, type === "supabase_project" ? account : target, v);
        if (r.ok) {
          toast.success(mask("text", r.message ?? "Asked."));
          onDone();
        } else {
          const field = r.fieldErrors ? Object.keys(r.fieldErrors)[0] : "form";
          setError({ field, text: mask("text", r.error) });
        }
      } catch {
        setError({ field: "form", text: "Watchbell didn't answer. Check that it's still running, then try again." });
      }
    });
  }

  const fe = (f: string) => (error?.field === f ? error.text : undefined);
  const firebaseBlocked = opts?.type === "firebase_project" && (!opts.envReady || !opts.connected);
  return (
    <>
      <div className="px-[18px] pb-2 pt-4">
        <DialogTitle className="text-base">{mask("text", `New ${TYPE_LABEL[type]}${type === "dns_record" || type === "neon_branch" ? ` in ${targetName}` : ""}`)}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
          {NOTE[type]} This only asks: the Owner approves it with the authenticator code, then the console checks the free tier again and makes one create call at {PROVIDER_NAME[type]}.
        </DialogDescription>
      </div>
      <div className="px-[18px] pt-1.5">
        {loadError && <div className="mb-3"><Banner tone="danger" title="Couldn't read the live choices">{loadError}</Banner></div>}
        {!opts && !loadError && <p className="mb-3 text-[13px] text-ink-soft">Reading the live choices…</p>}
        {type === "dns_record" && <DnsFields v={v} set={set} fe={fe} zone={targetName} />}
        {type === "neon_branch" && opts?.type === "neon_branch" && (
          <>
            <p className="mb-3 text-[13px] text-ink-soft">{opts.branches.length} of {opts.limit} branches used in this project.</p>
            <Field id="cr-parent" label="Copy from branch" error={fe("parentId")}>
              <select id="cr-parent" className={fieldClass} value={String(v.parentId ?? "")} onChange={(e) => set("parentId", e.target.value)}>
                {opts.branches.map((b) => <option key={b.id} value={b.id}>{mask("text", b.name)}{b.isDefault ? " (default)" : ""}</option>)}
              </select>
            </Field>
            <Field id="cr-name" label="New branch name" error={fe("name")} help="Lower-case letters, digits and hyphens, like preview-42.">
              <input id="cr-name" className={fieldClass} value={String(v.name ?? "")} maxLength={63} spellCheck={false} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
            </Field>
          </>
        )}
        {type === "supabase_project" && opts?.type === "supabase_project" && <SupabaseFields opts={opts} v={v} set={set} fe={fe} account={account} setAccount={setAccount} />}
        {type === "firebase_project" && opts?.type === "firebase_project" && <FirebaseFields opts={opts} v={v} set={set} fe={fe} />}
        {error?.field === "form" && <p className="mb-3 text-[12.5px] text-err" role="alert">{error.text}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-[18px] py-3">
        <Button onClick={onDone} disabled={pending}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={pending || !opts || firebaseBlocked}>{pending ? "Checking…" : "Check and ask for approval"}</Button>
      </div>
    </>
  );
}

type FieldsProps = { v: Record<string, string | number | boolean>; set: (k: string, val: string | number | boolean) => void; fe: (f: string) => string | undefined };

function DnsFields({ v, set, fe, zone }: FieldsProps & { zone: string }) {
  const proxiable = v.type !== "TXT";
  return (
    <>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 max-[560px]:grid-cols-1">
        <Field id="cr-type" label="Type" error={fe("type")}>
          <select id="cr-type" className={fieldClass} value={String(v.type)} onChange={(e) => set("type", e.target.value)}>
            {["A", "AAAA", "CNAME", "TXT"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field id="cr-name" label="Name" error={fe("name")} help={`A host in ${zone}: shop becomes shop.${zone}.`}>
          <input id="cr-name" className={fieldClass} value={String(v.name ?? "")} maxLength={253} spellCheck={false} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
        </Field>
      </div>
      <Field id="cr-content" label="Content" error={fe("content")} help={v.type === "CNAME" ? "For Vercel, copy the value shown on the project's Domains page." : undefined}>
        <input id="cr-content" className={fieldClass} value={String(v.content ?? "")} maxLength={2048} spellCheck={false} autoComplete="off" onChange={(e) => set("content", e.target.value)} />
      </Field>
      <Field id="cr-ttl" label="TTL" error={fe("ttl")}>
        <select id="cr-ttl" className={fieldClass} value={v.proxied ? AUTO_TTL : Number(v.ttl)} disabled={v.proxied === true} onChange={(e) => set("ttl", Number(e.target.value))}>
          {TTL_CHOICES.map((t) => <option key={t} value={t}>{ttlText(t)}</option>)}
        </select>
      </Field>
      {proxiable && (
        <label className="mb-3.5 flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="accent-brand" checked={v.proxied === true} onChange={(e) => set("proxied", e.target.checked)} />
          Proxied through Cloudflare (off by default; Vercel recommends DNS only)
        </label>
      )}
    </>
  );
}

function SupabaseFields({ opts, v, set, fe, account, setAccount }: FieldsProps & { opts: Extract<CreateOptions, { type: "supabase_project" }>; account: string; setAccount: (a: string) => void }) {
  const mask = useMask();
  const full = opts.active >= opts.limit;
  return (
    <>
      {opts.accounts.length > 1 && (
        <Field id="cr-acc" label="Supabase account">
          <select id="cr-acc" className={fieldClass} value={account} onChange={(e) => setAccount(e.target.value)}>
            {opts.accounts.map((a) => <option key={a.id} value={a.id}>{mask("account", a.label)}</option>)}
          </select>
        </Field>
      )}
      {opts.accounts.length === 0 && <div className="mb-3"><Banner tone="info" title="No Supabase account connected">Connect one in Connections first.</Banner></div>}
      {opts.error && <div className="mb-3"><Banner tone="danger" title="Can't create with this token">{opts.error}</Banner></div>}
      <p className="mb-3 text-[13px] text-ink-soft">{opts.active} of {opts.limit} active free projects in use.{full ? " Pause one first; paused projects don't count." : ""}</p>
      <Field id="cr-org" label="Organization" error={fe("orgSlug")} help="Paid or unknown plans are refused: a project there is billed from the first hour.">
        <select id="cr-org" className={fieldClass} value={String(v.orgSlug ?? "")} onChange={(e) => set("orgSlug", e.target.value)}>
          {opts.orgs.map((o) => <option key={o.slug} value={o.slug} disabled={!o.allowed}>{mask("text", o.name)} · {o.plan ?? "plan unknown"}{o.allowed ? "" : " (not allowed)"}</option>)}
        </select>
      </Field>
      <Field id="cr-name" label="Project name" error={fe("name")}>
        <input id="cr-name" className={fieldClass} value={String(v.name ?? "")} maxLength={63} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field id="cr-region" label="Region" error={fe("region")}>
        <select id="cr-region" className={fieldClass} value={String(v.region)} onChange={(e) => set("region", e.target.value)}>
          {SUPABASE_REGIONS.map(([code, name]) => <option key={code} value={code}>{name} · {code}</option>)}
        </select>
      </Field>
      <p className="mb-3 text-[12.5px] text-ink-soft">{opts.scopeNote}</p>
    </>
  );
}

function FirebaseFields({ opts, v, set, fe }: FieldsProps & { opts: Extract<CreateOptions, { type: "firebase_project" }> }) {
  if (!opts.envReady) return <div className="mb-3"><Banner tone="info" title="Google OAuth isn't set up">{ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true)}</Banner></div>;
  if (!opts.connected) {
    return (
      <div className="mb-3 flex flex-col gap-2">
        <Banner tone="info" title="Connect Google (create projects) first">The Firebase service accounts are viewer-only, so creating needs your own Google grant.</Banner>
        <ConnectGoogleCreateButton />
      </div>
    );
  }
  return (
    <>
      {opts.error && <div className="mb-3"><Banner tone="danger" title="Google">{opts.error}</Banner></div>}
      {opts.projects !== null && (
        <p className="mb-3 text-[13px] text-ink-soft">
          {opts.projects} active Google Cloud project{opts.projects === 1 ? "" : "s"}. Google&apos;s project quota without a billing account is about {opts.quotaHint} and isn&apos;t readable by API; deleted projects count for 30 days.
        </p>
      )}
      <Field id="cr-pid" label="Project id" error={fe("projectId")} help="6 to 30 lower-case letters, digits and hyphens. Permanent and global: pick one nobody has.">
        <input id="cr-pid" className={fieldClass} value={String(v.projectId ?? "")} maxLength={30} spellCheck={false} autoComplete="off" onChange={(e) => set("projectId", e.target.value)} />
      </Field>
      <Field id="cr-pname" label="Display name" error={fe("displayName")}>
        <input id="cr-pname" className={fieldClass} value={String(v.displayName ?? "")} maxLength={30} autoComplete="off" onChange={(e) => set("displayName", e.target.value)} />
      </Field>
    </>
  );
}

export function ConnectGoogleCreateButton({ reconnect = false }: { reconnect?: boolean }) {
  return (
    <ConfirmDialog
      trigger={<Button size="sm" variant="primary">{reconnect ? "Reconnect Google (create projects)" : "Connect Google (create projects)"}</Button>}
      title="Connect Google (create projects)"
      body={
        <>
          <p className="mb-2">Google will ask you to approve one permission, separate from the Drive backup one:</p>
          <p className="mb-2 rounded-md border border-line bg-sunken px-3 py-2 text-ink-soft">See, edit, configure, and delete your Google Cloud data (cloud-platform).</p>
          <ul className="list-disc space-y-1 pl-5 text-ink-soft">{CONNECT_EXPLAINER.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="mt-2 text-ink-soft">Before the first connect, add this redirect URI to the OAuth client in the Google Cloud console: <span className="font-mono text-[12px]">/auth/google/create/callback</span> on this site.</p>
        </>
      }
      cta="Continue to Google"
      onConfirm={async () => {
        const r = await startGoogleCreateConnect();
        if (!r.ok || !r.data) return { ok: false, message: r.ok ? "Watchbell didn't answer. Check that it's still running, then try again." : r.error };
        window.location.assign(r.data.url);
        return { ok: true, message: "Opening Google…" };
      }}
    />
  );
}

export function DisconnectGoogleCreateButton() {
  return (
    <ConfirmDialog
      trigger={<Button>Disconnect Google (create)</Button>}
      title="Disconnect Google (create projects)?"
      body="The console forgets the grant. Remove Watchbell's access in your Google Account → Security → Third-party access as well. Projects already created stay."
      cta="Disconnect"
      onConfirm={async () => {
        const r = await disconnectGoogleCreate();
        return r.ok ? { ok: true, message: r.message ?? "Disconnected." } : { ok: false, message: r.error };
      }}
    />
  );
}
