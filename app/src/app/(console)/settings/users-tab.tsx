import { desc, isNull } from "drizzle-orm";
import { Card } from "@/components/kit";
import { Resource } from "@/components/resource";
import { Status } from "@/components/status";
import { db } from "@/db/client";
import { invites, members } from "@/db/schema";
import { inviteStatus } from "@/lib/members";
import { isDemo, mode, usesLocalAuth } from "@/lib/mode";
import { AddMemberDialog } from "./add-member-dialog";
import { InviteDialog } from "./invite-dialog";
import { RemoveMember, RevokeInvite, RoleSelect } from "./member-actions";

const ago = (d: Date | null) => {
  if (!d) return "never";
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 2) return "now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export async function UsersTab({ actorId }: { actorId: string }) {
  // Self-host has no invites: an owner adds the account directly (Add member). The demo has no invites either, and
  // nobody can be added: the visitor is its only member.
  const localAuth = usesLocalAuth();
  const people = await db().select().from(members).orderBy(desc(members.createdAt));
  const pending = localAuth ? [] : await db().select().from(invites).where(isNull(invites.acceptedAt)).orderBy(desc(invites.createdAt));
  const now = new Date();
  const th = "border-y border-line bg-surface-2 px-3 py-2 text-left text-[12.5px] font-medium text-ink-soft first:pl-[18px]";
  const td = "border-b border-line px-3 py-[9px] whitespace-nowrap first:pl-[18px]";

  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-3 pt-3.5">
        {localAuth ? (
          <>
            <span className="text-ink-soft">
              {isDemo()
                ? "In the demo you are the only member. On a real install an owner adds people here."
                : "Members sign in with email and password. A new member gets a temporary password and picks their own at their first sign-in."}
            </span>
            {!isDemo() && <AddMemberDialog />}
          </>
        ) : (
          <>
            <span className="text-ink-soft">Invite-only: people sign in with an email link, and only invited emails get in. Preview deployments stay behind Vercel Authentication.</span>
            <InviteDialog />
          </>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead><tr><th className={th}>User</th><th className={th}>Role</th><th className={th}>Last seen</th><th className={th}>Status</th><th className={th} /></tr></thead>
          <tbody>
            {people.map((m) => (
              <tr key={m.id} className="hover:bg-hover">
                <td className={td}><Resource kind="usr" name={m.email} /></td>
                <td className={td}>{m.id === actorId ? <span className="rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-soft">Owner (you)</span> : <RoleSelect memberId={m.id} email={m.email} role={m.role} />}</td>
                <td className={`${td} text-ink-soft`}>{ago(m.lastSeenAt)}</td>
                <td className={td}><Status state="ok">Active</Status></td>
                <td className={td}>{m.id !== actorId && <RemoveMember memberId={m.id} email={m.email} deletesAccount={mode() === "selfhost"} />}</td>
              </tr>
            ))}
            {pending.map((i) => {
              const s = inviteStatus(i, now);
              return (
                <tr key={i.id} className="hover:bg-hover">
                  <td className={td}><Resource kind="usr" name={i.email} /></td>
                  <td className={td}><span className="rounded-[5px] border border-line bg-surface-2 px-1.5 text-xs text-ink-soft">{i.role[0].toUpperCase() + i.role.slice(1)}</span></td>
                  <td className={`${td} text-ink-soft`}>invited</td>
                  <td className={td}>{s === "open" ? <Status state="off">Invited</Status> : <Status state="warn">Invite expired</Status>}</td>
                  <td className={td}><RevokeInvite inviteId={i.id} email={i.email} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
