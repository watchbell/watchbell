import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/kit";
import { serverEnv } from "@/lib/env";
import { rel } from "@/lib/view/format";
import { mcpAgentsSeen } from "@/private/ai/views-db";
import { ConnectView } from "./connect-view";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";

export default async function ConnectPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  // An unreadable list must not break the page that explains how to connect: show "waiting" instead.
  const seen = await mcpAgentsSeen(now).catch(() => []);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "AI Gateway", href: "/ai" }, { label: "Connect an agent" }]}
        title="Connect an agent"
        sub="Agents connect to Watchbell's MCP server with a console key that has read:status. They can read apps, monitors, alerts, events, stored error logs and the advisor. The only writes are AI notes and answers, and only with write:notes."
        actions={<Link href="/ai/keys" className={buttonClass({ variant: "primary" })}>Create key</Link>}
      />
      <ConnectView
        siteUrl={serverEnv().SITE_URL}
        seen={seen.map((a) => ({ name: a.clientVersion ? `${a.clientName}/${a.clientVersion}` : a.clientName, key: a.keyName, ago: rel(a.lastSeenAt, now) }))}
      />
    </>
  );
}
