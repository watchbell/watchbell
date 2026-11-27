import { Banner, Card } from "@/components/kit";
import { Status } from "@/components/status";
import { eventTime } from "@/lib/view/format";
import type { SourceState } from "@/lib/view/sources";
import { SourcePanel } from "./source-panel";

// Watchbell 1.8.6 (mockup/watchbell-1-8-6.html, design Final): Alerts › Sources. The owner sets up, replaces, revokes
// and tests; a viewer sees the state only. The full URL never reaches this page: only the prefix, masked.
export type SourcesView = {
  state: SourceState; demo: boolean; owner: boolean; url: string | null; lastAlert: Date | null;
  received: number; refused: number; recent: { title: string; status: "firing" | "resolved"; at: Date }[]; now: Date;
};

const CHIP: Record<SourceState, { state: "ok" | "info" | "err"; text: string }> = {
  none: { state: "info", text: "not set up" }, active: { state: "ok", text: "active" },
  quiet: { state: "ok", text: "active · quiet" }, revoked: { state: "err", text: "revoked" },
};

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-0.5 py-1"><dt className="w-28 shrink-0 text-ink-soft">{k}</dt><dd className="min-w-0 break-all">{children}</dd></div>;
}

export function SourcesCard({ v }: { v: SourcesView }) {
  const has = v.state === "active" || v.state === "quiet";
  return (
    <div className="flex flex-col gap-4">
      <Card title="Alertmanager" meta={v.demo ? <Status state="info">demo</Status> : <Status state={CHIP[v.state].state}>{CHIP[v.state].text}</Status>}>
        <div className="flex flex-col gap-3.5">
          <p className="text-[13px] text-ink-soft">Prometheus Alertmanager posts its alerts here (webhook, version 4). They open, repeat and resolve with the same notices as Watchbell&apos;s own.</p>
          {v.demo ? (
            <Banner tone="info" title="Not available in the demo">It would accept alerts from the internet. Install Watchbell, or use your own console, to try it.</Banner>
          ) : (
            <>
              {v.state === "revoked" && <Banner tone="warning" title="The webhook URL was revoked">Alertmanager&apos;s calls now get 404 and open nothing.</Banner>}
              {!has && <p className="text-[13.5px]">Get a secret webhook URL, put it in <code>alertmanager.yml</code>, and Alertmanager&apos;s alerts show up in Firing.</p>}
              {has && (
                <dl className="text-[13.5px]">
                  <Fact k="Webhook URL"><span className="font-mono">{v.url}</span></Fact>
                  <Fact k="Last alert">{v.lastAlert ? eventTime(v.lastAlert, v.now) : "None yet"}</Fact>
                  <Fact k="This month">{v.received} alerts · {v.refused} refused</Fact>
                  <Fact k="Limit">120 alerts a minute · 256 KB a call</Fact>
                </dl>
              )}
              {v.state === "quiet" && <Banner tone="info" title="No alerts in 7 days or more">That&apos;s fine if nothing fired; check alertmanager.yml if you expected some.</Banner>}
              {v.owner ? <SourcePanel has={has} /> : !has && <p className="text-[13px] text-ink-faint">Only the owner can set this up.</p>}
              {has && v.recent.length > 0 && (
                <div>
                  <h3 className="mb-1 text-[13.5px] font-medium">Last received</h3>
                  <ul className="text-[13px]">
                    {v.recent.map((r, i) => (
                      <li key={i} className="flex justify-between gap-2.5 border-b border-sunken py-1.5 last:border-0">
                        <span className="min-w-0 break-words">{r.title}</span>
                        <span className="shrink-0 text-ink-soft">{r.status === "resolved" ? <Status state="ok">resolved</Status> : "firing"} · {eventTime(r.at, v.now)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </Card>
      <Card title="How alerts map">
        <dl className="text-[13.5px]">
          <Fact k="Title"><code>alertname</code> · <code>job</code> or <code>instance</code></Fact>
          <Fact k="Message"><code>summary</code> annotation, else <code>description</code> (500 characters at most)</Fact>
          <Fact k="Severity"><code>severity</code> label: critical or warning; anything else is info; none takes the rule&apos;s</Fact>
          <Fact k="Same alert">Alertmanager&apos;s fingerprint, so a repeat never opens a second one</Fact>
          <Fact k="Stale">No word for 24 h → resolved as stale</Fact>
        </dl>
        <p className="mt-2 text-[12.5px] text-ink-faint">The rule ExternalAlert (Rules tab) turns these on or off and picks their channels.</p>
      </Card>
    </div>
  );
}
