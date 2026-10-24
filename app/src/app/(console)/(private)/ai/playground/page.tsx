import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { effectiveDefault, enabledModels, isFresh, readAgSettings } from "@/private/ai/extras";
import { modelRows } from "@/private/ai/views-db";
import { initialModel, pickerOptions } from "./picker";
import { PlaygroundView } from "./playground-view";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { AI_COPY, PLAYGROUND_COPY } from "@/lib/copy/edition";
import { scheduleModelRefresh } from "@/private/ai/providers/refresh";

// The picker: provider models (real-time) and the Antigravity models switched on under AI › Models (owner 13 Oct 18:05:
// answered through the inbox by the VM). A failed Antigravity read only leaves those out.
async function agPicker(): Promise<{ models: { id: string; label: string }[]; def: string | null }> {
  try {
    const now = new Date();
    const { report, prefs, allowed } = await readAgSettings(now);
    // Owner 14 Oct: no ag/ models while Antigravity isn't connected (no fresh report from an active key).
    if (!isFresh(report, now)) return { models: [], def: null };
    const on = new Set(enabledModels(report, prefs, allowed));
    return { models: (report?.models ?? []).filter((m) => on.has(m.id)), def: effectiveDefault(report, prefs, allowed) };
  } catch {
    console.warn(AI_COPY.modelsReadFailed);
    return { models: [], def: null };
  }
}

export default async function PlaygroundPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  scheduleModelRefresh(); // custom servers' lists older than 10 min are re-detected after the response
  const [{ rows, defaultModel }, ag] = await Promise.all([modelRows(), agPicker()]);
  const provider = rows.filter((m) => m.enabled && m.providerEnabled).map((m) => m.publicId);
  const models = pickerOptions(provider, ag.models);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Manage" }, { label: "AI Gateway", href: "/ai" }, { label: "Playground" }]}
        title="Playground"
        sub={ag.models.length
          ? PLAYGROUND_COPY.subAgent
          : "Try a model from your provider with your owner session. Answers come in seconds and nothing is stored. Plain sends only your messages; Ask the console adds a scrubbed snapshot of your apps."}
      />
      {models.length === 0 ? (
        <Card>
          <EmptyState title="No model is on" action={<Link href="/ai/models" className={buttonClass({ size: "sm" })}>Open Models</Link>}>
            Connect a provider under Bring your own key and switch a model on under Models.
          </EmptyState>
        </Card>
      ) : <PlaygroundView models={models} defaultModel={initialModel(models, defaultModel, ag.def)} />}
    </>
  );
}
