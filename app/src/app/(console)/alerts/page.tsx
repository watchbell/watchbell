import Link from "next/link";
import { Banner, Card, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePageMember } from "@/lib/auth";
import { listFiring, listResolved, readMessageTemplates, rulesWithState } from "@/lib/data/alerts-db";
import { aliasBook } from "@/lib/data/cached";
import { channelViews } from "@/lib/data/notify-db";
import { pausedSections } from "@/lib/data/sections-db";
import { readNotifyLangs } from "@/lib/notify/lang";
import { extensions } from "@/lib/extensions";
import { SECTION_IDS, SECTIONS } from "@/lib/sections";
import { hideAlert } from "@/lib/view/display-name";
import { canAct } from "@/lib/view/labels";
import { ChannelsCard } from "./channels-card";
import { FiringTable, ResolvedTable } from "./firing-table";
import { RulesTable } from "./rules-table";
import { alertWorkspaceIds } from "@/lib/data/workspace-db";
import { filterByWorkspace, workspacePrefix } from "@/lib/workspace/alerts";
import { currentWorkspace } from "@/lib/workspace/current";

export default async function AlertsPage() {
  const member = await requirePageMember();
  const now = new Date();
  // Watchbell 1.2: the alerts of a section the owner turned off are paused and left out here until it is on again.
  const paused = await pausedSections();
  const [allFiring, allResolved, rules, channels, book, langs, templates, ws] = await Promise.all([listFiring(paused), listResolved(now), rulesWithState(), channelViews(), aliasBook(), readNotifyLangs(), readMessageTemplates(), currentWorkspace()]);
  // Watchbell 1.8: the chosen workspace's alerts and the install's own (at most 200 open, filtered here so the count
  // under the list and the bell's always add up); with All workspaces each alert names its workspace.
  const wsOf = await alertWorkspaceIds([...allFiring, ...allResolved]);
  const { shown: stored, elsewhere } = filterByWorkspace(allFiring, wsOf, ws.id);
  const { shown: storedResolved } = filterByWorkspace(allResolved, wsOf, ws.id);
  const labelled = ws.id === null && ws.list.length > 1;
  const label = (id: string) => (labelled ? workspacePrefix(ws.list.find((w) => w.id === wsOf.get(id))?.name ?? "Install", ws.list.length) : "");
  const pausedNames = SECTION_IDS.filter((id) => paused.has(id)).map((id) => SECTIONS[id].label);
  // Privacy: databases by alias and no emails in titles, messages and causes, stored rows included.
  const firing = stored.map((a) => { const shown = hideAlert(a, book); return { ...shown, title: label(a.id) + shown.title, search: [a.title, a.message].join(" ") }; });
  const resolved = storedResolved.map((a) => ({ ...a, title: label(a.id) + hideAlert({ ...a, message: "", causedBy: null }, book).title }));
  const owner = member.role === "owner";
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "Alerts" }]}
        title="Alerts"
        sub="Rules run after every collector run. Unknown data never opens or resolves an alert."
      />
      <Tabs defaultValue="firing" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="firing">Firing</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        <TabsContent value="firing" className="flex flex-col gap-4">
          {pausedNames.length > 0 && (
            <Banner tone="info" title={`Paused: ${pausedNames.join(", ")}`} action={owner ? <Link href="/manage/sections">Sections</Link> : undefined}>
              The alerts of a section that is turned off are kept but not shown, evaluated or sent until it is turned on again.
            </Banner>
          )}
          <Card flush><FiringTable rows={firing} now={now} act={canAct(member.role)} /></Card>
          {elsewhere > 0 && (
            <p className="text-[13px] text-ink-soft"><Link href="/workspaces">{elsewhere} more open in other workspaces</Link></p>
          )}
          {resolved.length > 0 && (
            <Card title="Resolved in the last 7 days" flush><ResolvedTable rows={resolved} now={now} /></Card>
          )}
        </TabsContent>

        <TabsContent value="rules">
          <Card flush><RulesTable rules={rules} owner={owner} templates={templates} now={now} /></Card>
        </TabsContent>

        <TabsContent value="notifications">
          <ChannelsCard views={channels} owner={owner} now={now} approvals={!!extensions.telegramCallback} langs={langs} />
        </TabsContent>
      </Tabs>
    </>
  );
}
