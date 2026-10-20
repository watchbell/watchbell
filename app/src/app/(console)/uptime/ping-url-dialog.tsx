"use client";

import { IconHeartbeat } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";
import { Masked } from "@/components/alias";
import { Button } from "@/components/kit";
import { useHoldRefresh } from "@/components/live";
import { pingTestPath, pingTestResult } from "@/lib/ping-test";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// U3 (mockup pingUrlDlg): the ping URL, shown once right after Add heartbeat or Show ping URL. The console keeps only
// its hash, so once this closes the URL is gone from the page too (the parent drops it). Screenshot mode shows the host
// masked and the token as dots; Copy still copies the real URL (it is the owner's own clipboard).
export function PingUrlDialog({ name, url, onClose }: { name: string; url: string | null; onClose: () => void }) {
  const open = url !== null;
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useHoldRefresh(open);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy. Select the URL and copy it yourself.");
    }
  }

  // Test the real URL from this browser (same origin), so the owner needs no terminal. The token is never logged.
  async function send(kind: "ok" | "fail") {
    const path = url ? pingTestPath(url, kind) : null;
    if (!path || sending) return;
    setSending(true);
    setResult(null);
    try {
      const r = await fetch(path, { method: "GET", cache: "no-store" });
      setResult(pingTestResult(r.status));
    } catch {
      setResult(pingTestResult(null));
    } finally {
      setSending(false);
    }
  }
  function close() {
    setResult(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="gap-0 p-0 sm:max-w-[640px]" showCloseButton={false}>
        <div className="flex items-start gap-3 px-[18px] pb-2 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-soft"><IconHeartbeat size={19} /></span>
          <div className="min-w-0">
            <DialogTitle className="text-base">Ping URL for <Masked kind="text" real={name} /></DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-ink-soft">
              Copy it now. It is shown once; the console keeps only a hash. Lost it? Make a new one from the monitor&apos;s menu.
            </DialogDescription>
          </div>
        </div>
        <div className="px-[18px] pt-2">
          <div className="mb-3 flex items-center gap-1.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-sunken px-2 py-1.5 font-mono text-[12.5px]">{url && <Masked kind="text" real={url} masked={url.replace(/(\/api\/ping\/).*/, "$1••••••")} />}</code>
            <Button size="sm" onClick={copy}>Copy</Button>
          </div>
          <div className="mb-3.5 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={sending} onClick={() => send("ok")}>Send test ping</Button>
            <Button size="sm" disabled={sending} onClick={() => send("fail")}>Test fail</Button>
            <span role="status" aria-live="polite" className={`text-[13px] ${result ? (result.ok ? "text-ok" : "text-err") : "text-ink-soft"}`}>{sending ? "Sending…" : (result?.text ?? "")}</span>
          </div>
          <div className="mb-3.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
            <b className="font-medium">From your job</b>
            <ul className="mt-1 list-disc pl-[18px] text-ink-soft">
              <li>When it succeeds: <span className="font-mono">curl -fsS -m 10 &lt;url&gt;</span></li>
              <li>When it fails: add <span className="font-mono">/fail</span> to the URL</li>
              <li>When it starts (optional): add <span className="font-mono">/start</span></li>
            </ul>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-[18px] py-3">
          <Button variant="primary" onClick={close}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
