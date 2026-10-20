import { members } from "@/db/schema";
import { DAY, type SeedCtx } from "./context";
import { stableId } from "./rng";

const MEMBER_AGE_DAYS = 410;

// The visitor is the demo's only member: an owner, under the email they signed in with. The user id comes from the
// seed, so it is the same each time this visitor's database is re-created.
export function demoUserId(seed: string): string {
  return stableId(seed, "member", "user");
}

// The member row's own id (what action_proposals.decided_by and similar columns hold).
export function memberRowId(seed: string): string {
  return stableId(seed, "member", "row");
}

export async function seedMember(ctx: SeedCtx): Promise<void> {
  const { now, seed } = ctx;
  // Older than every seeded account and app (apps are at most ~400 days old): the owner was there first.
  const joined = new Date(now.getTime() - MEMBER_AGE_DAYS * DAY);
  await ctx.db.insert(members).values({
    id: memberRowId(seed), userId: demoUserId(seed), email: ctx.email, role: "owner",
    lastSeenAt: now, createdAt: joined, updatedAt: joined,
  });
}
