// P2: the app page's "Open in" menu. Only what is known is listed; every entry opens in a new tab. No new provider
// calls: the repo and team come from Sync's project data, databases from stage 3's links, the zone from Cloudflare.
export type OpenInInput = {
  teamSlug: string | null; projectName: string; repo: string | null; repoType: string | null; siteUrl: string;
  dbs: { kind: string; externalId: string; name: string }[]; zone: { accountId: string | null; name: string } | null;
};

const GIT: Record<string, string> = { github: "https://github.com/", gitlab: "https://gitlab.com/", bitbucket: "https://bitbucket.org/" };
const enc = encodeURIComponent;

function dbLink(d: { kind: string; externalId: string; name: string }): { label: string; href: string } | null {
  if (d.kind === "supabase_project") return { label: `Supabase · ${d.name}`, href: `https://supabase.com/dashboard/project/${enc(d.externalId)}` };
  if (d.kind === "neon_project") return { label: `Neon · ${d.name}`, href: `https://console.neon.tech/app/projects/${enc(d.externalId)}` };
  if (d.kind === "firestore") return { label: `Firebase · ${d.name}`, href: `https://console.firebase.google.com/project/${enc(d.externalId)}/overview` };
  return null;
}

export function openInLinks(i: OpenInInput): ({ label: string; href: string } | "---")[] {
  const top: { label: string; href: string }[] = [];
  if (i.teamSlug) top.push({ label: "Vercel project", href: `https://vercel.com/${enc(i.teamSlug)}/${enc(i.projectName)}` });
  const git = i.repoType ? GIT[i.repoType] : undefined;
  if (git && i.repo) top.push({ label: "Git repository", href: `${git}${i.repo.split("/").map(enc).join("/")}` });
  top.push({ label: "Live site", href: i.siteUrl });
  const more = [
    ...i.dbs.map(dbLink).filter((x): x is { label: string; href: string } => x !== null),
    ...(i.zone?.accountId ? [{ label: `Cloudflare · ${i.zone.name}`, href: `https://dash.cloudflare.com/${enc(i.zone.accountId)}/${enc(i.zone.name)}` }] : []),
  ];
  return more.length ? [...top, "---", ...more] : top;
}
