import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import type { HostedProvider } from "@/data/hosting";

// Watchbell 1.6 Deploy an app: which hosts Watchbell syncs today. A host counts as connected only with a working
// account; when every account of it fails (status error), it is broken: the page asks for a fix, not a deploy.
const HOSTED: readonly HostedProvider[] = ["vercel"];

export type HostStates = { connected: Set<HostedProvider>; broken: Set<HostedProvider> };

export function hostStates(rows: readonly { provider: string; status: string }[]): HostStates {
  const connected = new Set<HostedProvider>();
  const broken = new Set<HostedProvider>();
  for (const p of HOSTED) {
    const mine = rows.filter((r) => r.provider === p);
    if (mine.some((r) => r.status === "ok")) connected.add(p);
    else if (mine.length) broken.add(p);
  }
  return { connected, broken };
}

export async function connectedHosts(): Promise<HostStates> {
  const rows = await db().select({ provider: accounts.provider, status: accounts.status }).from(accounts).where(inArray(accounts.provider, [...HOSTED]));
  return hostStates(rows);
}
