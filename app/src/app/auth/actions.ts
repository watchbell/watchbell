"use server";

import { redirect } from "next/navigation";
import { authProvider } from "@/lib/auth-provider";

export async function signOut() {
  await authProvider().signOut();
  redirect("/signin");
}
