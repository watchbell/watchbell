import { accounts, deployments, resources, snapshots } from "@/db/schema";
import { pickFlags } from "@/lib/collector/deploy-sync";
import { appState } from "@/lib/collector/rules";
import type { State } from "@/lib/status";
import { ago, DAY, HOUR, MINUTE, type SeedCtx } from "./context";
import { APP_NAMES, COMMIT_MESSAGES, demoHost, FAILED_COMMIT, FRAMEWORKS, PREVIEW_BRANCHES, REGIONS, REPO_ORG, TEAMS } from "./names";
import { rngFor, stableHex, stableId, stableToken } from "./rng";

// One Vercel account with 5-8 watched apps, as Sync and the collector's `vercel` task write them: the project rows with
// Sync's meta, and 30 days of deployments (the retention) with the current / previous production flags. Across all
// apps exactly one production build failed (the newest deploy of its app, a few hours ago) and one preview is building.

export type SeededApp = { id: string; index: number; name: string; externalId: string; host: string; createdAt: Date };
export type SeededApps = { accountId: string; team: { id: string; name: string; slug: string }; apps: SeededApp[] };

type DeploymentRow = typeof deployments.$inferInsert;

export async function seedApps(ctx: SeedCtx): Promise<SeededApps> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "apps");
  const t = rng.pick(TEAMS);
  const team = { id: `team_${stableToken(24, seed, "team")}`, name: t.name, slug: t.slug };
  const accountId = stableId(seed, "account", "vercel");
  const connected = ago(now, rng.int(120, 300) * DAY);
  const synced = ago(now, rng.int(3, 50) * MINUTE);
  await db.insert(accounts).values({
    id: accountId, provider: "vercel", label: team.name,
    // Not a credential: nothing in the demo calls Vercel, so there is nothing to decrypt.
    credentialCiphertext: "demo", credentialIv: "demo", credentialKind: "Access token",
    status: "ok", lastTestAt: synced, lastSyncAt: synced, createdAt: connected, updatedAt: synced,
  });

  const names = rng.shuffle(APP_NAMES).slice(0, rng.int(5, 8)).sort();
  const apps: SeededApp[] = names.map((name, index) => ({
    id: stableId(seed, "app", name), index, name, externalId: `prj_${stableToken(28, seed, "project", name)}`,
    host: demoHost(name), createdAt: ago(now, rng.int(95, 400) * DAY - rng.int(0, 23) * HOUR),
  }));
  await db.insert(resources).values(apps.map((a) => ({
    id: a.id, accountId, kind: "app" as const, externalId: a.externalId, name: a.name, monitored: true,
    firstSeenAt: a.createdAt, lastSeenAt: synced, createdAt: a.createdAt, updatedAt: synced,
    meta: {
      teamId: team.id, teamSlug: team.slug, teamName: team.name, framework: rng.pick(FRAMEWORKS), productionBranch: "main",
      createdAt: a.createdAt.toISOString(), repo: `${REPO_ORG}/${a.name}`, repoType: "github", functionRegions: [rng.pick(REGIONS)],
    },
  })));

  await db.insert(deployments).values(deploymentRows(ctx, apps));
  return { accountId, team, apps };
}

function deploymentRows(ctx: SeedCtx, apps: SeededApp[]): DeploymentRow[] {
  const { seed, now } = ctx;
  const rng = rngFor(seed, "deployments");
  const failedApp = rng.pick(apps).id;
  const buildingApp = rng.pick(apps).id;
  const rows: DeploymentRow[] = [];
  for (const app of apps) {
    const add = (n: number, target: "production" | "preview", createdAgo: number, state: "ready" | "error" | "building", message?: string) => {
      const created = ago(now, createdAgo);
      const building = new Date(created.getTime() + rng.int(3, 12) * 1000);
      const ready = state === "ready" ? new Date(building.getTime() + rng.int(25, 160) * 1000) : null;
      const branch = target === "production" ? "main" : rng.pick(PREVIEW_BRANCHES);
      rows.push({
        id: stableId(seed, "deployment", app.name, n), resourceId: app.id, externalId: `dpl_${stableToken(24, seed, "deployment", app.name, n)}`,
        state, target, branch,
        commitSha: stableHex(40, seed, "commit", app.name, n), commitMessage: message ?? rng.pick(COMMIT_MESSAGES), source: "git",
        url: demoHost(`${app.name}-git-${branch.replace(/[^a-z0-9]+/g, "-")}-${stableToken(9, seed, "deployment-url", app.name, n).toLowerCase()}`),
        buildingAt: building, readyAt: ready, createdAtProvider: created, isCurrent: false, isPreviousProduction: false,
        createdAt: created, updatedAt: ready ?? building,
      });
    };
    // Production: 2-5 ready deploys over the last 30 days, the newest within the last 4 days (at least 20 min ago, so
    // none reads as just finishing). The app with the failed build has its newest ready deploy before that build.
    const failed = app.id === failedApp;
    const prod = rng.int(2, 5);
    for (let i = 0; i < prod; i++) {
      const createdAgo = i === 0
        ? Math.max(failed ? 5 * HOUR : 0, rng.int(1, 96) * HOUR - rng.int(0, 40) * MINUTE)
        : rng.int(4 + i * 4, 6 + i * 6) * DAY + rng.int(0, 23) * HOUR;
      add(i, "production", createdAgo, "ready");
    }
    // Previews: 0-3 ready ones from the last 10 days.
    const previews = rng.int(0, 3);
    for (let i = 0; i < previews; i++) add(10 + i, "preview", rng.int(2, 240) * HOUR + rng.int(0, 59) * MINUTE, "ready");
    if (failed) add(20, "production", rng.int(30, 240) * MINUTE, "error", FAILED_COMMIT);
    if (app.id === buildingApp) add(21, "preview", rng.int(1, 6) * MINUTE, "building");
  }
  // Current is the newest ready production deploy, previous the one before it (what a Hobby rollback targets).
  for (const app of apps) {
    const ready = rows.filter((r) => r.resourceId === app.id && r.target === "production" && r.state === "ready")
      .map((r) => ({ id: r.externalId, createdAt: r.createdAtProvider }));
    const { currentId, previousId } = pickFlags(ready, null);
    for (const r of rows) {
      if (r.resourceId !== app.id) continue;
      r.isCurrent = r.externalId === currentId;
      r.isPreviousProduction = r.externalId === previousId;
    }
  }
  return rows;
}

// What the app snapshots need from each monitor: its live state and last result.
export type MonitorFacts = { appId: string; state: State; lastStatus: number | null; lastLatencyMs: number | null; stateSince: Date; createdAt: Date };

// The app's state row, as the collector's refreshAppSnapshots derives it from the monitors (down beats degraded), with
// the last 24 h of page views (Vercel Web Analytics) that the `pageviews` task merges in.
export async function seedAppSnapshots(ctx: SeedCtx, seeded: SeededApps, mons: MonitorFacts[]): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "snapshots");
  const collected = ago(now, rng.int(5, 40) * 1000);
  await db.insert(snapshots).values(seeded.apps.map((app) => {
    const own = mons.filter((m) => m.appId === app.id);
    const state = appState({ monitors: own.map((m) => m.state), building: false, dbPaused: false });
    const worst = own.find((m) => m.state === "err") ?? own.find((m) => m.state === "warn");
    // When the app's state began: the change of the monitor that decides it, else the latest change among them.
    const since = worst?.stateSince ?? new Date(Math.max(...own.map((m) => m.stateSince.getTime())));
    return {
      resourceId: app.id, state, stateSince: since, collectedAt: collected,
      data: { code: worst?.lastStatus ?? null, latencyMs: own[0]?.lastLatencyMs ?? null, dbPaused: false, pageviews: pageViews(rng, now) },
    };
  }));
}

// 24 hourly counts with a day/night swing (busiest in the WIB afternoon), as storedPageViews writes them.
function pageViews(rng: ReturnType<typeof rngFor>, now: Date) {
  const readAt = ago(now, rng.int(2, 25) * MINUTE);
  const lastHour = Math.floor(readAt.getTime() / HOUR) * HOUR;
  const peak = rng.int(20, 400);
  const hourly: [string, number][] = Array.from({ length: 24 }, (_, i) => {
    const at = lastHour - (23 - i) * HOUR;
    const wibHour = (new Date(at).getUTCHours() + 7) % 24;
    const swing = 0.15 + 0.85 * Math.max(0, Math.sin(((wibHour - 6) / 24) * 2 * Math.PI));
    return [new Date(at).toISOString(), Math.round(peak * swing * (0.7 + 0.6 * rng.next()))];
  });
  const total = hourly.reduce((s, [, n]) => s + n, 0);
  return { enabled: true, total24h: total, visitors24h: Math.round(total * (0.3 + 0.2 * rng.next())), hourly, readAt: readAt.toISOString() };
}
