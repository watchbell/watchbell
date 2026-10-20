"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { invites, members } from "@/db/schema";
import { findOpenInvite, getSessionUser } from "@/lib/auth";

export async function acceptInvite() {
  const session = await getSessionUser();
  if (!session) redirect("/signin");
  const invite = await findOpenInvite(session.email);
  if (!invite) redirect("/invite");
  await db().transaction(async (tx) => {
    await tx.insert(members).values({ userId: session.userId, email: session.email, role: invite.role, invitedBy: invite.invitedBy, lastSeenAt: new Date() }).onConflictDoNothing();
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
  });
  redirect("/");
}
