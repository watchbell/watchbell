import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";

// R2: every page of the private feature (5c) is the owner's alone. Server Actions check again (requireActionMember).
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const { ok, member } = await pageGate("owner");
  return ok ? children : <NoAccess role={member.role} />;
}
