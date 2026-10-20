import { Card, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pageGate } from "@/lib/auth";
import { listStoredLogs } from "@/lib/data/logs-db";
import { appOptions } from "@/lib/data/monitors-db";
import { toWire } from "@/lib/view/logs";
import { LogViewer } from "./log-viewer";

// The live read asks Vercel's request logs once per app (up to 8 s, a few pages) inside this page's server action.
export const maxDuration = 30;

export default async function LogsPage() {
  const { ok, member } = await pageGate("operator");
  if (!ok) return <NoAccess role={member.role} />;
  const now = new Date();
  const [apps, stored] = await Promise.all([appOptions(), listStoredLogs(now)]);
  const appList = apps.map((a) => ({ id: a.id, name: a.name }));
  // No AutoRefresh here: the live tab polls itself and the stored tab is a 7-day view. The live tab starts empty and
  // reads when it opens.
  return (
    <>
      <PageHeader crumbs={[{ label: "Observe" }, { label: "Logs" }]} title="Logs"
        sub="Vercel Hobby keeps only a short history of request logs. The collector copies warnings and errors every 5 minutes so you can look back 7 days." />
      <Tabs defaultValue="live" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="live">Last hour</TabsTrigger>
          <TabsTrigger value="stored">Stored errors</TabsTrigger>
        </TabsList>
        <TabsContent value="live"><Card flush><LogViewer mode="live" apps={appList} initial={[]} vercelUrl={null} /></Card></TabsContent>
        <TabsContent value="stored"><Card flush><LogViewer mode="stored" apps={appList} initial={stored.map(toWire)} vercelUrl={null} /></Card></TabsContent>
      </Tabs>
    </>
  );
}
