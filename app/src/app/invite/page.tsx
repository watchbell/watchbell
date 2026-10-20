import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/kit";
import { findOpenInvite, getSessionUser } from "@/lib/auth";
import { dayMonth } from "@/lib/time";
import { acceptInvite } from "./actions";

const CAN: Record<string, string[]> = {
  owner: ["Everything, including connections, users, and settings"],
  operator: ["See every app, database, domain, and alert", "Redeploy, restore, wake, and silence alerts", "Not change connections, users, or settings"],
  viewer: ["See every app, database, domain, and alert", "No logs and no actions"],
};

export default async function InvitePage() {
  const session = await getSessionUser();
  if (!session) redirect("/signin");
  const invite = await findOpenInvite(session.email);
  const roleName = invite ? invite.role[0].toUpperCase() + invite.role.slice(1) : "";

  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[400px] max-w-full rounded-xl border border-line bg-surface p-7">
        <span className="mb-[18px] grid size-7 place-items-center rounded-[7px] bg-brand font-mono text-xs font-semibold text-on-brand">WB</span>
        {invite ? (
          <>
            <h1 className="mb-1 text-xl">You&apos;re invited</h1>
            <p className="mb-[18px] text-ink-soft">
              <b className="font-medium text-ink">{session.email}</b> was invited to Watchbell as {invite.role === "operator" ? "an" : "a"} {roleName}.
            </p>
            <div className="mb-3.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
              <b className="font-medium">{roleName}s can</b>
              <ul className="mt-1 list-disc pl-[18px] text-ink-soft">{CAN[invite.role].map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
            <form action={acceptInvite}><Button type="submit" variant="primary" className="w-full justify-center">Accept invite</Button></form>
            <p className="mt-3.5 text-[12.5px] text-ink-faint">This invite works until {dayMonth(invite.expiresAt)}. Not you? Sign out.</p>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-xl">This invite isn&apos;t valid anymore</h1>
            <p className="mb-[18px] text-ink-soft">It expired or was withdrawn. Ask an owner for a new one.</p>
          </>
        )}
        <form action={signOut} className="mt-2"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
      </div>
    </main>
  );
}
