import { type Host, type HostedProvider, type LangId, LANGS, type LangTile } from "@/data/hosting";

// Watchbell 1.6 Deploy an app: what the button under the host table does. Watchbell never deploys through a provider
// API here; it opens the provider's own new-project page (the repository is picked there, see Host.menu), sends the
// owner to Connections first for a host Watchbell syncs, or shows a guide's steps.

export type NextStep =
  | { kind: "deploy"; href: string; label: string }
  | { kind: "connect"; href: string; label: string }
  | { kind: "ask"; label: string }
  | { kind: "guide"; label: string; steps: string[] };

export function langForRepo(language: string | null, langs: LangTile[] = LANGS): LangId | null {
  const l = language?.trim().toLowerCase();
  if (!l) return null;
  return langs.find((t) => t.github.some((g) => g.toLowerCase() === l))?.id ?? null;
}

// The tile after a repository is chosen (review I4): a tile the user picked stays; so does one the repository fits
// (a TypeScript repository on Next.js); otherwise the repository's language decides, when it has a tile.
export function langAfterRepo(current: LangTile, language: string | null, touched: boolean, langs: LangTile[] = LANGS): LangId {
  const l = language?.trim().toLowerCase();
  if (touched || !l) return current.id;
  if ([...current.github, ...(current.fits ?? [])].some((g) => g.toLowerCase() === l)) return current.id;
  return langForRepo(language, langs) ?? current.id;
}

// Once on the host's page: where to click, and which repository to pick there (not where there is none to pick).
export function handoffHint(host: Host, repo: string | null): string {
  if (!host.menu) return `On ${host.name}: import ${repo ?? "your repository"} from GitHub.`;
  if (host.menu.includes("{repo}")) return `On ${host.name}: ${host.menu.replace("{repo}", repo ?? "the repository")}.`;
  return `On ${host.name}: ${host.menu}${repo && host.picksRepo !== false ? `, then pick ${repo}` : ""}.`;
}

export function nextStep(host: Host, opts: { connected: ReadonlySet<HostedProvider>; broken?: ReadonlySet<HostedProvider>; owner: boolean }): NextStep {
  if (host.cost === "guide" || host.guide?.length) return { kind: "guide", label: "Show the steps", steps: host.guide ?? [] };
  if (host.provider && !opts.connected.has(host.provider) && opts.broken?.has(host.provider)) {
    return opts.owner
      ? { kind: "connect", label: `Fix the ${host.name} connection`, href: `/connections?provider=${host.provider}` }
      : { kind: "ask", label: `Ask the owner to fix the ${host.name} connection` };
  }
  if (host.provider && !opts.connected.has(host.provider)) {
    return opts.owner
      ? { kind: "connect", label: `Connect ${host.name} first`, href: `/connections?provider=${host.provider}` }
      : { kind: "ask", label: `Ask the owner to connect ${host.name}` };
  }
  return { kind: "deploy", label: `Deploy on ${host.name}`, href: host.newUrl };
}

// Review I2: syncing is claimed only while the connection works.
export function watchLine(host: Host, s: { connected: ReadonlySet<HostedProvider>; broken: ReadonlySet<HostedProvider> }): string {
  if (!host.provider) return "Uptime checks only";
  if (s.connected.has(host.provider)) return "Syncs it: deployments, logs and uptime";
  if (s.broken.has(host.provider)) return "Connection failing: fix it to sync";
  return `Syncs it once ${host.name} is connected`;
}

// New Vercel projects aren't watched until ticked (accounts.watchNew is off by default; discovery runs daily or on
// Sync now), so the page says where the new app turns up instead of promising it.
export const afterDeploy = (host: Host): string =>
  host.provider
    ? "After the next sync (daily, or Sync now) it's listed under Sync on Connections: tick it there, or turn on Watch new ones automatically."
    : "When it's live, add its address to Uptime.";
