import Link from "next/link";
import { Card } from "@/components/kit";
import { AutoRunForm } from "./auto-run-form";
import { AutoRollbackForm } from "./auto-rollback-form";
import { AutoSecurityForm } from "./auto-security-form";
import { ACTION_KINDS, readAutoRollback, readAutoRun, readAutoSecurity, ROLLBACK_WINDOW_MAX, ROLLBACK_WINDOW_MIN } from "./proposals-settings";
import { ACTIONS } from "./proposals-types";

// Settings › Auto-actions (Stage 9 slice 1; tab key office-auto-run). The Settings page itself is Owner only. Which safe
// action kinds a proposal may run without asking; risky kinds always wait for the owner and have no switch.
export const AUTO_RUN_WHAT: Record<keyof typeof ACTIONS, string> = {
  recheck: "Runs the monitor's check once, like Check now on the monitor.",
  neon_wake: "Wakes a suspended Neon compute, like Wake on the database page.",
  supabase_keepalive: "Sends one keep-alive query to a Supabase project close to auto-pause, like Keep active.",
  supabase_restore: "Restores a paused Supabase project.",
  vercel_redeploy: "Redeploys the current production deployment.",
  vercel_rollback: "Rolls production back to the previous ready deployment.",
  github_bump_pr: "Opens a pull request on a new branch that raises vulnerable packages to their fixed versions (needs the GitHub PR-write token).",
  daily_rerun: "Calls the console's daily job again when its heartbeat is down. Always asks for approval.",
  domain_recheck: "Re-reads a domain's TLS certificate and expiry when its certificate looks close to expiry, like Re-check on Domains.",
};

export async function OfficeAutoRunTab() {
  const [saved, rollback, security] = await Promise.all([readAutoRun(), readAutoRollback(), readAutoSecurity()]);
  const choices = [10, 15, 20, 30, 45, 60, 90, 120].filter((m) => m >= ROLLBACK_WINDOW_MIN && m <= ROLLBACK_WINDOW_MAX);
  const rows = ACTION_KINDS.map((kind) => ({ kind, label: ACTIONS[kind].label, risky: ACTIONS[kind].risk === "risky", what: AUTO_RUN_WHAT[kind] }));
  return (
    <Card title="Auto-actions" flush meta="All off by default">
      <p className="px-[18px] pb-3 text-ink-soft">
        When a firing alert brings a proposal for one of these actions, a switched-on kind runs without asking and you get a
        short Telegram line afterwards. Everything else waits for you on <Link href="/auto-actions">Auto-actions</Link>.
        Auto-run only does what the console button does, through the same checks, and every run is in the audit log (Events).
      </p>
      <AutoRunForm saved={saved} rows={rows} />
      <div className="border-t border-line px-[18px] pb-4 pt-3.5">
        <h3 className="mb-1.5 text-[14px]">Auto-rollback after a bad deploy</h3>
        <p className="mb-2.5 text-ink-soft">
          Off by default. When on, a new production deploy that breaks the app is rolled back to the previous one without
          asking. Only <span className="font-mono text-[12.5px]">vercel_rollback</span>, only within the first N minutes after a
          new production deploy goes live, only when a monitor is down or the logs show an error spike, at most once per
          deployment (and never twice for one app within 2 hours), and every run is reported on Telegram and in Events.
          Failed builds never go live on Vercel, so this is for builds that succeed but break at runtime.
        </p>
        <AutoRollbackForm saved={rollback} choices={choices} />
      </div>
      <div className="border-t border-line px-[18px] pb-4 pt-3.5">
        <h3 className="mb-1.5 text-[14px]">Automatic security fixes</h3>
        <p className="mb-2 text-ink-soft">
          On by default. When a dependency scan finds a critical or high advisory with a fix, Watchbell fixes it end to end:
        </p>
        <ol className="mb-2.5 list-decimal pl-5 text-ink-soft [&_li]:mt-0.5">
          <li>opens the update PR itself (package.json only, on a new watchpost/deps-… branch), only for direct packages that stay in their major version, never twice for the same package while a PR is open;</li>
          <li>waits for GitHub&apos;s checks (all green), then Vercel&apos;s preview of the PR (READY);</li>
          <li>tests the preview: &quot;/&quot; and up to 3 monitor paths must answer 200–399 within 15 s (behind Vercel Authentication: 3 minutes without error lines in the preview&apos;s logs);</li>
          <li>squash-merges it, only while auto-rollback is on: the production deploy then runs on Vercel and auto-rollback guards its first minutes.</li>
        </ol>
        <p className="mb-2.5 text-ink-soft">
          Anything failing, or not done within 45 minutes, leaves the PR open marked &quot;needs a look&quot;. A major update, a
          transitive package or a severity you switched off waits for your approval on Auto-actions, as before. Every PR opened
          and every merge or stop is sent to Telegram and logged in Events. Needs the GitHub PR-write token on Connections.
        </p>
        <AutoSecurityForm saved={security} rollbackOn={rollback.enabled} />
      </div>
    </Card>
  );
}
