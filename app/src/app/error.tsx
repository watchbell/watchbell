"use client";

import { ErrorView } from "@/components/error-view";
import { demoNoticeForDigest } from "@/lib/demo/notices";

// Covers the pages outside the console shell (sign-in, invite) and a failure in the console layout itself,
// which (console)/error.tsx can't catch: in demo that is where the console layout's "busy" lands (lib/demo/notices.ts).
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <div className="w-[460px] max-w-full">
        <ErrorView digest={error.digest} retry={retry} withSignOut notice={demoNoticeForDigest(error.digest) ?? undefined} />
      </div>
    </main>
  );
}
