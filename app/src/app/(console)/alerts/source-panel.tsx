"use client";

import { IconArrowLeft, IconCheck } from "@tabler/icons-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Button, Card } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { Status } from "@/components/status";
import { cn } from "@/lib/utils";
import { alertmanagerYml, WIZARD_POLL_MAX_MS, WIZARD_POLL_MS } from "@/lib/view/sources";
import { revokeSourceAction, sendTestAlertAction, setupSourceAction, sourceStatusAction } from "./source-actions";

// Watchbell 1.8.6: the owner's buttons and the 3-step set-up (mockup design Final). It stays at one place in the page,
// so the page's refresh after a set-up doesn't unmount it and lose the URL, which exists only in this component's
// state and is never shown again. Step 3 asks the server every 5 s for at most 2 minutes, and only while it is open.
const STEPS = ["Get the URL", "Add it to Alertmanager", "Check it works"];
type Wait = { state: "waiting" } | { state: "received"; title?: string } | { state: "timeout" };

export function SourcePanel({ has }: { has: boolean }) {
  const [wiz, setWiz] = useState<{ url: string; since: string } | null>(null);
  const [step, setStep] = useState(1);
  const [pending, start] = useTransition();
  useHoldRefresh(wiz !== null);

  async function setup(): Promise<{ ok: boolean; message: string }> {
    const since = new Date().toISOString();
    const r = await setupSourceAction();
    if (!r.ok || !r.data) return { ok: false, message: r.ok ? "Watchbell didn't send the URL back. Try again." : r.error };
    setWiz({ url: r.data.url, since });
    setStep(1);
    return { ok: true, message: "Copy the URL now: it's shown once." };
  }

  if (wiz) return <Wizard url={wiz.url} since={wiz.since} step={step} setStep={setStep} close={() => setWiz(null)} />;

  if (!has) {
    return (
      <div>
        <Button variant="primary" disabled={pending} onClick={() => start(async () => { const r = await setup(); if (!r.ok) toast.error(r.message); })}>
          {pending ? "Making the URL…" : "Set up Alertmanager"}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <ConfirmDialog
        trigger={<Button>Replace URL</Button>}
        title="Replace the webhook URL?"
        body="The current URL stops working at once. Put the new one in alertmanager.yml and reload Alertmanager."
        cta="Replace URL"
        onConfirm={setup}
      />
      <ConfirmDialog
        trigger={<Button variant="danger">Revoke</Button>}
        title="Revoke the webhook URL?"
        body="Alertmanager's calls get 404 from now on. Alerts it already opened stay open until they resolve or go 24 hours without word."
        cta="Revoke"
        danger
        onConfirm={async () => { const r = await revokeSourceAction(); return r.ok ? { ok: true, message: r.message ?? "Revoked." } : { ok: false, message: r.error }; }}
      />
      <Button disabled={pending} onClick={() => start(async () => {
        const r = await sendTestAlertAction();
        if (r.ok) toast.success(r.message ?? "Test alert sent."); else toast.error(r.error);
      })}>Send a test alert</Button>
    </div>
  );
}

function Wizard({ url, since, step, setStep, close }: { url: string; since: string; step: number; setStep: (n: number) => void; close: () => void }) {
  const [wait, setWait] = useState<Wait>({ state: "waiting" });
  const [round, setRound] = useState(0);

  // Step 3 only: ask every WIZARD_POLL_MS until it arrived or WIZARD_POLL_MAX_MS passed; stop when the step closes.
  useEffect(() => {
    if (step !== 3) return;
    let stopped = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      const r = await sourceStatusAction(since).catch(() => null);
      if (stopped) return;
      if (r?.ok && r.data?.received) { stopped = true; setWait({ state: "received", title: r.data.title }); return; }
      if (Date.now() - started >= WIZARD_POLL_MAX_MS) { stopped = true; setWait({ state: "timeout" }); }
    };
    const id = setInterval(tick, WIZARD_POLL_MS);
    void tick();
    return () => { stopped = true; clearInterval(id); };
  }, [step, since, round]);

  const yml = alertmanagerYml(url);
  const done = (i: number) => i + 1 < step || (i === 2 && wait.state === "received");
  return (
    <Card>
      <div className="flex flex-col gap-3.5">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={close}><IconArrowLeft size={14} aria-hidden /> Back to Sources</Button>
          <h3 className="mt-1 text-[16px] font-semibold">Set up Alertmanager</h3>
        </div>
        <ol aria-label="Steps" className="flex flex-wrap gap-2 text-[13.5px]">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i + 1 === step ? "step" : undefined} className={cn("flex items-center gap-2", i + 1 === step ? "font-semibold" : "text-ink-faint")}>
              <span className={cn("grid size-6 place-items-center rounded-full font-mono text-[12px]", done(i) ? "bg-ok text-on-brand" : i + 1 === step ? "bg-brand text-on-brand" : "bg-sunken")}>
                {done(i) ? <IconCheck size={13} aria-label="done" /> : i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <>
            <p className="text-[13.5px] text-ink-soft">This secret URL is shown only here and only now. Copy it before you go on; anyone who has it can send alerts to this console.</p>
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3">
              <b className="text-[13px] font-medium">Webhook URL · shown once</b>
              <code className="break-all font-mono text-[12.5px]">{url}</code>
              <div><CopyButton text={url} label="Copy URL" /></div>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <p className="text-[13.5px] text-ink-soft">Merge both parts into your <code>alertmanager.yml</code>: the receiver under <code>receivers:</code>, the route as the first entry of your route&apos;s <code>routes:</code>. <code>continue: true</code> keeps every alert going to your other receivers too. Then reload Alertmanager (<code>curl -X POST localhost:9093/-/reload</code>).</p>
            <pre className="overflow-x-auto rounded-lg bg-code-bg p-3 font-mono text-[12.5px] text-code-text">{yml}</pre>
            <div><CopyButton text={yml} label="Copy alertmanager.yml" /></div>
          </>
        )}
        {step === 3 && (
          wait.state === "received" ? (
            <p role="status" className="text-[13.5px]"><Status state="ok">Received{wait.title ? ` "${wait.title}"` : ""}. Alertmanager is connected.</Status></p>
          ) : wait.state === "timeout" ? (
            <div className="flex flex-col gap-2 text-[13.5px]">
              <p role="status"><Status state="warn">Nothing arrived in 2 minutes.</Status></p>
              <p className="text-ink-soft">Check the URL in alertmanager.yml, that Alertmanager was reloaded, and that it can reach this console. Then send a test alert again.</p>
              <div><Button onClick={() => { setWait({ state: "waiting" }); setRound((n) => n + 1); }}>Check again</Button></div>
            </div>
          ) : (
            <p role="status" className="text-[13.5px] text-ink-soft">
              Waiting for a test alert… send one with <code>amtool alert add WatchbellTest severity=info --alertmanager.url=http://localhost:9093</code>. Watchbell checks every 5 seconds for 2 minutes.
            </p>
          )
        )}

        <div className="flex justify-between gap-2 border-t border-sunken pt-3">
          <Button disabled={step === 1} onClick={() => setStep(step - 1)}>Back</Button>
          {step < 3
            ? <Button variant="primary" onClick={() => setStep(step + 1)}>{step === 1 ? "I copied it — next" : "Done — next"}</Button>
            : <Button variant="primary" disabled={wait.state !== "received"} onClick={() => { toast.success("Alertmanager is set up."); close(); }}>Finish</Button>}
        </div>
      </div>
    </Card>
  );
}
