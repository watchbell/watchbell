import { IconDownload, IconKey } from "@tabler/icons-react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonClass, Card, PageHeader } from "@/components/kit";
import { AI_COPY } from "@/lib/copy/edition";
import { serverEnv } from "@/lib/env";
import { enabledModels, isFresh, readAgSettings } from "@/private/ai/extras";
import { modelRows } from "@/private/ai/views-db";
import { EndpointList } from "@/private/explorer/endpoint-list";
import { Explorer } from "@/private/explorer/explorer";
import { type ExplorerModels, NO_MODELS } from "@/private/explorer/live-model";
import { explorerModels } from "@/private/explorer/page-models";
import { originFrom } from "@/private/explorer/origin";
import { OPS, opById } from "@/private/openapi/operations";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { isDevRuntime } from "@/lib/dev-only";
import { LOCAL_ORIGIN, PRODUCTION_ORIGIN } from "@/private/ui/snippets";

// API explorer (owner only, the (private) layout gates it): every endpoint from one OpenAPI 3.1 description. The
// optional segment picks the endpoint: /api-docs, /api-docs/status, /api-docs/ai-chat. The mockup's #/api/<op>.

// Stage 8 cleanup: the localhost fallback is for development only.
function fallbackOrigin(): string {
  try {
    return serverEnv().SITE_URL;
  } catch {
    return isDevRuntime() ? LOCAL_ORIGIN : PRODUCTION_ORIGIN;
  }
}

// The owner's live models for the example bodies and the Model list: what GET /api/v1/ai/models gives an unpinned key.
// ag/ models only while Antigravity is connected (a fresh report). A failed read leaves the generic example in place.
async function liveModels(): Promise<ExplorerModels> {
  const ag = async (): Promise<{ connected: boolean; ids: string[] }> => {
    try {
      const now = new Date();
      const { report, prefs, allowed } = await readAgSettings(now);
      return isFresh(report, now) ? { connected: true, ids: enabledModels(report, prefs, allowed) } : { connected: false, ids: [] };
    } catch {
      console.warn(AI_COPY.modelsReadFailed);
      return { connected: false, ids: [] };
    }
  };
  try {
    const [{ rows, defaultModel }, agState] = await Promise.all([modelRows(), ag()]);
    return explorerModels({ rows, defaultModel, ag: agState });
  } catch {
    console.warn("reading the models for the API explorer failed");
    return NO_MODELS;
  }
}

export default async function ApiExplorerPage({ params }: { params: Promise<{ op?: string[] }> }) {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const { op: parts } = await params;
  if (parts && parts.length > 1) notFound();
  const op = parts?.length ? opById(parts[0]) : OPS[0];
  if (!op) notFound();
  const [origin, models] = await Promise.all([headers().then((h) => originFrom(h, fallbackOrigin())), liveModels()]);

  return (
    <>
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "API explorer", href: "/api-docs" }, { label: op.path }]}
        title="API explorer"
        sub="Every endpoint from one OpenAPI 3.1 file. Try a request with a console API key; it runs against this deployment with that key's scopes and rate limit."
        actions={
          <>
            <a href="/api/v1/openapi.json" download="openapi.json" className={buttonClass()}><IconDownload size={16} aria-hidden />openapi.json</a>
            <Link href="/ai/keys" className={buttonClass()}><IconKey size={16} aria-hidden />API keys</Link>
          </>
        }
      />
      <div className="mt-4 grid grid-cols-1 items-start gap-4 min-[960px]:grid-cols-[268px_minmax(0,1fr)]">
        <Card flush><EndpointList activeId={op.id} /></Card>
        <Explorer key={op.id} opId={op.id} origin={origin} models={models} />
      </div>
    </>
  );
}
