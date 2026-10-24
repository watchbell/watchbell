import { PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pageGate } from "@/lib/auth";
import { extensions } from "@/lib/extensions";
import { statusPageSettings } from "@/lib/data/public-status-db";
import { serverEnv } from "@/lib/env";
import { ActionsLockfileCard } from "./actions-lockfile-card";
import { BudgetTab } from "./budget-tab";
import { CollectorTab } from "./collector-tab";
import { RetentionTab } from "./retention-tab";
import { StatusPageTab } from "./status-page-tab";
import { UsersTab } from "./users-tab";

const TAB_KEYS = ["collector", "budget", "users", "retention", "status-page"];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const gate = await pageGate("owner");
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const [{ tab }, statusPage] = await Promise.all([searchParams, statusPageSettings()]);
  const extra = extensions.settingsTabs ?? [];
  // The GitHub Actions lockfile card is a core tab of its own, unless the VM runner is registered (private edition,
  // registry r1): its Runner tab, the first extension tab, shows the card beside the runner.
  const lockfileTab = !extensions.runner;
  const keys = [...TAB_KEYS, ...(lockfileTab ? ["lockfile"] : []), ...extra.map((t) => t.key)];
  return (
    <>
      <PageHeader crumbs={[{ label: "Manage" }, { label: "Settings" }]} title="Settings" />
      {/* key: the menu's Status page link (/settings?tab=status-page) opens that tab even when Settings is already open. */}
      <Tabs key={tab ?? ""} defaultValue={tab && keys.includes(tab) ? tab : "users"} className="mt-3.5">
        <TabsList variant="line">
          <TabsTrigger value="collector">Collector</TabsTrigger>
          <TabsTrigger value="budget">Free tier budget</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="retention">Retention</TabsTrigger>
          <TabsTrigger value="status-page">Status page</TabsTrigger>
          {lockfileTab && <TabsTrigger value="lockfile">Lockfile</TabsTrigger>}
          {extra.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="collector" className="mt-4"><CollectorTab /></TabsContent>
        <TabsContent value="budget" className="mt-4"><BudgetTab /></TabsContent>
        <TabsContent value="users" className="mt-4"><UsersTab actorId={gate.member.id} /></TabsContent>
        <TabsContent value="retention" className="mt-4"><RetentionTab /></TabsContent>
        <TabsContent value="status-page" className="mt-4"><StatusPageTab settings={statusPage} siteUrl={serverEnv().SITE_URL} /></TabsContent>
        {lockfileTab && <TabsContent value="lockfile" className="mt-4"><ActionsLockfileCard /></TabsContent>}
        {extra.map(({ key, Tab }) => <TabsContent key={key} value={key} className="mt-4"><Tab /></TabsContent>)}
      </Tabs>
    </>
  );
}
