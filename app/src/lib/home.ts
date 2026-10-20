import type { Role } from "@/lib/roles";

// Owners land on the first-run page until something is connected; after that, and for everyone else, the Overview.
export function homePath({ role, accountCount }: { role: Role; accountCount: number }): string {
  return role === "owner" && accountCount === 0 ? "/welcome" : "/overview";
}
