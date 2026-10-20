import { count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { requirePageMember } from "@/lib/auth";
import { homePath } from "@/lib/home";

export default async function Home() {
  const member = await requirePageMember();
  const [{ n }] = await db().select({ n: count() }).from(accounts);
  redirect(homePath({ role: member.role, accountCount: n }));
}
