import { connection } from "next/server";
import { enabledModels, isFresh, readAgSettings } from "@/private/ai/extras";
import { hasEnabledProvider } from "@/private/ai/views-db";
import { ports } from "@/private/assist/ports";
import { NoProviderBanner } from "@/private/ui/no-provider";
import { AiSubnav } from "@/private/ui/subnav";

// The AI Gateway shell: the left menu and, on every sub-page, the "No provider connected" banner while nothing is
// enabled (an info banner instead while Antigravity reported its models within 24 h). Owner only: (private)/layout.tsx gates it. The banner is informational, so a failed read hides it.
export default async function AiLayout({ children }: { children: React.ReactNode }) {
  // Rendered per request (the console's own layout reads the session cookie anyway). Without this, `next build`
  // prerendered every /ai/* route and these reads ran there, with no request and no database ("reading ai.defaultModel
  // failed" once per route; on Vercel the same reads would go to the real database).
  await connection();
  const [connected, provider] = await Promise.all([hasEnabledProvider().catch(() => true), ports.provider().catch(() => null)]);
  const now = new Date();
  const agModels = connected ? null : await readAgSettings(now)
    .then(({ report, prefs, allowed }) => (isFresh(report, now) ? enabledModels(report, prefs, allowed).length : null))
    .catch(() => null);
  return (
    <div className="grid grid-cols-[196px_minmax(0,1fr)] items-start gap-6 max-[900px]:grid-cols-1">
      <AiSubnav />
      <div className="flex min-w-0 flex-col gap-4">
        <NoProviderBanner show={!connected} antigravityModels={agModels} provider={provider} />
        {children}
      </div>
    </div>
  );
}
