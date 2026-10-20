import { CreateRequestList } from "@/components/create/create-requests";
import { trimFinished } from "@/lib/create/split";
import type { CreateType } from "@/lib/create/types";
import { listRequests } from "@/lib/data/create-db";
import type { Member } from "@/lib/auth";

// Stage 6 create requests: the waiting list for a page (its types) or Overview (all). Server component; the table is
// read fresh each render (requests are rare and short-lived). A failed read shows nothing rather than breaking the page.
export async function PendingCreates({ member, types, focus, title, waitingOnly = false }: { member: Member; types?: CreateType[]; focus?: string | null; title?: string; waitingOnly?: boolean }) {
  const all = await listRequests(member.id, types).catch(() => []);
  const items = waitingOnly ? all.filter((i) => i.status === "requested") : trimFinished(all, new Date());
  return <CreateRequestList items={items} owner={member.role === "owner"} focus={focus ?? null} {...(title ? { title } : {})} />;
}
