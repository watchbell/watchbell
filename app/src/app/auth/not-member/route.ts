import { redirect } from "next/navigation";
import { authProvider } from "@/lib/auth-provider";

export async function GET() {
  await authProvider().signOut();
  redirect("/signin?error=not-member");
}
