import { Card, PageHeader } from "@/components/kit";
import { NoAccess } from "@/components/no-access";
import { HOSTING_CHECKED_ON, HOSTING_SOURCES, HOSTS, LANGS } from "@/data/hosting";
import { pageGate } from "@/lib/auth";
import { listApps } from "@/lib/data/apps-db";
import { connectedHosts } from "@/lib/data/deploy-db";
import { listRepoItems } from "@/lib/data/repos-db";
import { appStatus } from "@/lib/view/labels";
import { AppsWhere } from "./apps-where";
import { DeployPicker } from "./deploy-picker";

// Watchbell 1.6, Hosting › Deploy an app (spec §6, mockup view "hosting"): pick a language and a host, then hand off
// to the host's own new-project page. The host list is src/data/hosting.ts, checked on HOSTING_CHECKED_ON.
export default async function DeployPage({ searchParams }: { searchParams?: Promise<{ repo?: string | string[] }> } = {}) {
  const { ok, member } = await pageGate("operator");
  if (!ok) return <NoAccess role={member.role} />;
  const [list, hosts, params, apps] = await Promise.all([listRepoItems(), connectedHosts(), searchParams, listApps(new Date())]);
  const repo = typeof params?.repo === "string" ? params.repo : undefined;
  const repos = list.items.filter((r) => !r.archived).map((r) => ({ fullName: r.fullName, language: r.language, private: r.private }));
  const where = apps.filter((a) => !a.gone).map((a) => {
    const s = appStatus(a);
    return { id: a.id, name: a.name, domain: a.domain, runsOn: "Vercel", detail: a.teamName, state: s.state, label: s.label };
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Hosting" }, { label: "Deploy an app" }]}
        title="Deploy an app"
        sub={`Pick the language, then where it should run. Free hosts come first; anything that costs money or needs a card says so. Checked ${HOSTING_CHECKED_ON}.`}
        more="Watchbell doesn't deploy anything itself here: the button opens the host's own new-project page and says which repository to pick there. A new Vercel project is synced and watched once you tick it under Sync on Connections; any other host can be watched through Uptime."
      />
      <Card>
        <DeployPicker langs={LANGS} hosts={HOSTS} repos={repos} github={list.connected} connected={[...hosts.connected]} broken={[...hosts.broken]} repoNote={list.languageNote} owner={member.role === "owner"} initialRepo={repo} />
      </Card>
      <AppsWhere rows={where} />
      <Card title={`As checked on ${HOSTING_CHECKED_ON}`} meta="Official pages">
        <p className="text-[12.5px] text-ink-soft">
          {HOSTING_SOURCES.map(([name, url], i) => (
            <span key={name}>{i > 0 && " · "}<a href={url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{name}</a></span>
          ))}
        </p>
      </Card>
    </>
  );
}
