import { pageGate } from "@/lib/auth";
import { ports } from "@/private/assist/ports";
import { loadAskContext } from "@/private/assist/provider-answer";
import { latestFor } from "@/private/assist/questions-db";
import { WhyAi } from "./why-ai";

// Registry slot WhyAiSlot (R2: owner only; renders nothing for anyone else). A failing read leaves the block out
// rather than breaking the app page.
export async function WhyAiSlot({ appId }: { appId: string }) {
  const { ok } = await pageGate("owner");
  if (!ok) return null;
  const now = new Date();
  const [provider, q, ctx] = await Promise.all([
    ports.provider().catch(() => null), latestFor("app", appId, now).catch(() => null), loadAskContext(now).catch(() => null),
  ]);
  const question = q ? { ...q, createdAt: q.createdAt.toISOString(), answeredAt: q.answeredAt?.toISOString() ?? null } : null;
  return <WhyAi appId={appId} provider={provider ? { model: provider.model } : null} question={question} nowMs={now.getTime()} agConnected={ctx?.agConnected ?? false} />;
}
