"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { signOut } from "@/app/auth/actions";
import { Button, Card, EmptyState } from "@/components/kit";

// Shown by the error boundaries. It never prints error.message: on the server that text can carry
// internals (hostnames, SQL, env names). The digest is a hash that matches the line in the server logs.
// The escape is a real sign-out (it clears the session cookies): a plain link to /signin would bounce a
// still-signed-in browser straight back to the failing page.
// `note` is a status line under the text, for example the console's "Retrying…" while it retries on its own.
// `notice`: a message meant for the visitor (the demo's "busy", lib/demo/notices.ts) shown instead of the usual text.
export function ErrorView({ digest, retry, withSignOut = false, note, notice }: { digest?: string; retry: () => void; withSignOut?: boolean; note?: string; notice?: string }) {
  return (
    <Card>
      <EmptyState
        icon={IconAlertTriangle}
        title={notice ? "Try again soon" : "Something went wrong"}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => retry()}>Try again</Button>
            {withSignOut && <form action={signOut}><Button type="submit">Sign out</Button></form>}
          </div>
        }
      >
        {notice ?? "The console couldn't load this page. The database or Supabase may be unreachable, or a setting is missing."}
        {note && <p className="mt-2 text-xs text-ink-soft" role="status">{note}</p>}
        {digest && !notice && <p className="mt-2 font-mono text-xs text-ink-faint">Reference {digest}</p>}
      </EmptyState>
    </Card>
  );
}
