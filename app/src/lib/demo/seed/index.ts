import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { seedAlerts } from "./alerts";
import { seedAppSnapshots, seedApps } from "./apps";
import type { SeedCtx } from "./context";
import { seedDatabases } from "./databases";
import { seedEvents } from "./events";
import { seedMember } from "./members";
import { seedNetwork } from "./network";
import { seedAiUsage, seedLogs, seedProviderStatus } from "./observe";
import { seedProposals } from "./proposals";
import { seedUptime } from "./uptime";

export { demoUserId } from "./members";

// Fills a freshly migrated demo database (one per visitor) with made-up data, deterministic for `seed`: the same seed
// always gives the same rows and ids, with every time placed relative to `now`. One transaction, so a failure leaves
// nothing half-seeded. Each module draws from its own random stream (./rng), so a module added here doesn't change
// the rows of the others. Later modules tie their rows to what earlier ones return (alerts to the failed build, the
// outage and the expiring certificate; proposals to those alerts).
//
// Foreign keys aren't checked while seeding (session_replication_role = replica skips their per-row triggers; the
// self-host schema has no triggers of its own): the 90 days of uptime history are tens of thousands of rows, and the
// checks were about half the seed's time, which on a Vercel function is seconds a new visitor waits (27 Oct).
// seed.test.ts seeds with them checked (foreignKeyChecks), so a row that points nowhere still fails there.
export async function seedDemoDb(db: Db, seed: string, now: Date, email: string, { foreignKeyChecks = false } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    if (!foreignKeyChecks) await tx.execute(sql`set local session_replication_role = replica`);
    const ctx: SeedCtx = { db: tx, seed, now, email };
    await seedMember(ctx);
    const apps = await seedApps(ctx);
    const uptime = await seedUptime(ctx, apps);
    await seedAppSnapshots(ctx, apps, uptime.monitors);
    const dbs = await seedDatabases(ctx, apps);
    const net = await seedNetwork(ctx, apps, dbs);
    const alerts = await seedAlerts(ctx, apps, uptime, dbs, net);
    await seedProposals(ctx, alerts, net, uptime);
    await seedEvents(ctx, apps, uptime, dbs, net, alerts);
    await seedLogs(ctx, apps);
    await seedProviderStatus(ctx);
    await seedAiUsage(ctx);
  });
}
