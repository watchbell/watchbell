import { unstable_rethrow } from "next/navigation";
import { demoNoticeOf } from "@/lib/demo/notices";
import { DEMO_UNAVAILABLE, isDemoRefusal } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import type { Role } from "@/lib/roles";

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; data?: T };

export class AuthError extends Error {
  constructor(public reason: "signed-out" | "not-member" | "forbidden" | "mfa" | "password-change") {
    super(reason);
  }
}

export type GuardMember = { id: string; userId: string; email: string; role: Role };

const MESSAGES: Record<AuthError["reason"], string> = {
  "signed-out": "Your session ended. Sign in again.",
  "not-member": "Your email isn't on this console.",
  forbidden: "You don't have permission to do that.",
  mfa: "Confirm your sign-in with your authenticator code first.",
  "password-change": "Change your temporary password first.",
};

// What an action does in demo mode (lib/demo/simulate.ts). Left out: the action is refused with "Not available in the
// demo" (fail-closed: anything that may reach a provider). "local": it only reads or writes the visitor's own demo
// database, so it runs as usual. A function: a simulated variant runs instead of `fn`. Ignored in cloud and self-host.
export type DemoPolicy<T> = "local" | ((member: GuardMember) => Promise<ActionResult<T>>);

export async function runGuarded<T>(
  min: Role,
  fn: (member: GuardMember) => Promise<ActionResult<T>>,
  deps: { requireActionMember: (min: Role) => Promise<GuardMember> },
  demo?: DemoPolicy<T>,
): Promise<ActionResult<T>> {
  try {
    const member = await deps.requireActionMember(min);
    if (isDemo()) {
      if (!demo) return { ok: false, error: DEMO_UNAVAILABLE };
      return await (demo === "local" ? fn(member) : demo(member));
    }
    return await fn(member);
  } catch (e) {
    unstable_rethrow(e); // redirect(), notFound() and friends must reach Next.js
    if (e instanceof AuthError) return { ok: false, error: MESSAGES[e.reason] };
    // The demo's fetch guard (or an explicit refusal) stopped a call to a provider.
    if (isDemoRefusal(e)) return { ok: false, error: DEMO_UNAVAILABLE };
    // The demo's pool couldn't open the visitor's database (busy, too many new sessions): say so, not "went wrong".
    const notice = isDemo() ? demoNoticeOf(e) : null;
    if (notice) return { ok: false, error: notice };
    console.error("action failed:", e instanceof Error ? e.name : "unknown");
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
