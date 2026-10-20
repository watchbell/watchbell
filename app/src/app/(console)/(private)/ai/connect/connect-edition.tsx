import Link from "next/link";
import { Card } from "@/components/kit";
import { CodeTabs } from "@/private/ui/code-tabs";
import { mcpUrl, serverSetup } from "@/private/ui/snippets";
import { scope, stepBox, stepNo } from "./connect-classes";

// The open source edition's parts of AI › Connect an agent (exported as connect-edition.tsx): the same names as the
// private edition's. No app-specific note under the configs (each client's tab says where its config goes), and a
// server card for any MCP client that runs headless. Rendered inside ConnectView, a client component; no hooks here.

export function AgentAppNote(): null {
  return null;
}

// "Run on a server (24/7)": the server's key, its setup and schedule, and its heartbeat. `origin`: the server choice above.
export function ServerCard({ origin }: { origin: string }) {
  return (
    <Card title="Run on a server (24/7)" meta="Headless server · outbound HTTPS only">
      <p className="mb-2 max-w-[860px] text-[13px] text-ink-soft">
        An agent on your laptop only works while the laptop is on. For checks around the clock, run one on a small server you reach over SSH (for example through Tailscale).
        The URLs below follow the server choice above ({mcpUrl(origin)}).
      </p>
      <ol className="m-0 list-none p-0">
        <li className={stepBox}>
          <span className={stepNo}>1</span>
          <div className="min-w-0">
            <h3 className="mb-1 mt-0.5 text-[14px] font-medium">Create a key for the server</h3>
            <p className="mb-2 text-[13px] text-ink-soft">
              Its own key, named after the server (for example <span className="font-mono text-[12.5px]">server-agents</span>), with <span className={scope}>read:status</span>{" "}
              <span className={scope}>write:notes</span>. If the server is lost, revoke that key and nothing else changes. <Link href="/ai/keys">API keys</Link>
            </p>
          </div>
        </li>
        <li className={stepBox}>
          <span className={stepNo}>2</span>
          <div className="min-w-0">
            <h3 className="mb-1 mt-0.5 text-[14px] font-medium">Register Watchbell on the server, then schedule it</h3>
            <p className="mb-1 text-[13px] text-ink-soft">
              <b className="font-medium text-ink">OpenClaw</b> keeps running as a service and can also be reached from Telegram once you set up its Telegram channel (an OpenClaw feature, nothing Watchbell needs).{" "}
              <b className="font-medium text-ink">Gemini CLI</b> runs one prompt per call, so cron starts it every 6 hours; its settings file expands <span className="font-mono text-[12.5px]">$WATCHBELL_API_KEY</span> from the environment.
              Check the flags against <span className="font-mono text-[12.5px]">gemini --help</span> on the server, they change between versions.
            </p>
            <CodeTabs tabs={serverSetup(origin)} label="Run on a server" />
          </div>
        </li>
        <li className={stepBox}>
          <span className={stepNo}>3</span>
          <div className="min-w-0">
            <h3 className="mb-1 mt-0.5 text-[14px] font-medium">Watch the server itself</h3>
            <p className="mb-0 text-[13px] text-ink-soft">
              The last tab is a heartbeat line: the server calls Watchbell every 5 minutes, and Watchbell alerts you when the calls stop. Create the heartbeat under{" "}
              <Link href="/uptime">Uptime</Link> › Add monitor › Heartbeat, copy its ping URL into the crontab line, and keep the token private.
            </p>
          </div>
        </li>
      </ol>
      <p className="mb-0 mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-ink-soft">
        <b className="font-medium text-ink">Network:</b> the server only needs outbound HTTPS to Watchbell (and to Google for Gemini). Watchbell never connects into the server or your
        tailnet; it only answers the server&apos;s requests, so nothing has to be opened on it.
      </p>
    </Card>
  );
}
