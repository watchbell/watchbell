import { IconLoader2, IconMessage2, IconMessageQuestion } from "@tabler/icons-react";
import { Masked, MaskedText } from "@/components/alias";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { NoAccess } from "@/components/no-access";
import { pageGate } from "@/lib/auth";
import { aliasBook } from "@/lib/data/cached";
import { ago, zoneLabel } from "@/lib/time";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { AG_PUBLIC_PREFIX, enabledModels, isFresh, readAgSettings } from "@/private/ai/extras";
import { scheduleModelRefresh } from "@/private/ai/providers/refresh";
import { isOfferedModel } from "@/private/ai/providers/routing";
import { modelRows } from "@/private/ai/views-db";
import { ports } from "@/private/assist/ports";
import { listThread, type ThreadItem } from "@/private/assist/questions-db";
import { Markdown } from "@/private/notes/markdown";
import { AiBox } from "@/private/slots/ai-box";
import { ASK_COPY } from "@/lib/copy/edition";
import { AskForm } from "./ask-form";

// AI › Ask (mockup AI_VIEWS.ask, owner 13 Oct 14:40): free questions to Antigravity and every question of the last
// 7 days (from here, from an app's Why dialog, from the API), newest first. The answer arrives over MCP
// (answer_question); while one waits the page refreshes every 15 s instead of 60 s. Names follow the console's privacy
// rules: app names and free text are masked in screenshot mode, alert titles carry database aliases, and the
// agent's markdown goes through the notes renderer (no HTML).
const FAST_MS = 15_000;
// The Ask Server Action waits for the provider (a router combo can take ~25 s); Vercel Hobby allows up to 60 s.
export const maxDuration = 60;

export default async function AiAskPage() {
  const gate = await pageGate("owner"); // R2, again here: a layout doesn't stop its page from running
  if (!gate.ok) return <NoAccess role={gate.member.role} />;
  const now = new Date();
  scheduleModelRefresh();
  const book = await aliasBook().catch(() => EMPTY_BOOK);
  const [items, models] = await Promise.all([listThread(now, book), askModels(now)]);
  const waiting = items.some((i) => i.status === "pending");

  return (
    <>
      <AutoRefresh at={now.getTime()} everyMs={waiting ? FAST_MS : undefined} />
      <PageHeader
        crumbs={[{ label: "AI & API" }, { label: "AI Gateway", href: "/ai" }, { label: "Ask" }]}
        title="Ask"
        sub="Questions about the console, answered by your own provider (Bring your own key) from scrubbed console data. Owner only."
      />
      <Card title="New question"><AskForm models={models.list} defaultLabel={models.defaultLabel} /></Card>
      <Card title="Questions" meta="Newest first · last 7 days">
        {items.length === 0 ? (
          <EmptyState icon={IconMessageQuestion} title="No questions yet">
            {ASK_COPY.empty}
          </EmptyState>
        ) : (
          <ul className="m-0 list-none p-0">
            {items.map((q) => <Thread key={q.id} q={q} now={now} />)}
          </ul>
        )}
      </Card>
    </>
  );
}

// The model picker (owner 14 Oct): the provider models that are on (Default = the default provider's default model),
// then the Antigravity models switched on, only while Antigravity is connected. A failed read only shortens the list.
async function askModels(now: Date): Promise<{ list: { id: string; label: string }[]; defaultLabel: string }> {
  const [rows, provider, ag] = await Promise.all([
    modelRows().then((r) => r.rows).catch(() => []),
    ports.provider().catch(() => null),
    readAgSettings(now).catch(() => null),
  ]);
  const list = rows.filter((m) => m.enabled && m.providerEnabled && isOfferedModel(m, m.providerKind)).map((m) => ({ id: m.publicId, label: m.publicId }));
  if (ag && isFresh(ag.report, now)) {
    const on = new Set(enabledModels(ag.report, ag.prefs, ag.allowed));
    for (const m of ag.report?.models ?? []) if (on.has(m.id)) list.push({ id: `${AG_PUBLIC_PREFIX}${m.id}`, label: `${AG_PUBLIC_PREFIX}${m.id} · ${m.label}${ASK_COPY.agModelSuffix}` });
  }
  return { list, defaultLabel: provider ? provider.model : "no provider" };
}

// "3 min ago", then the local clock with its zone ("today 09:00 WIB", "12 Oct 21:14 WIB").
function when(d: Date, now: Date): string {
  const s = ago(d, now);
  return /\d:\d\d$/.test(s) ? `${s} ${zoneLabel(d)}` : s;
}

const chip = "inline-block max-w-[280px] truncate rounded border border-line bg-surface-2 px-1.5 text-[12px] text-ink-soft";

function Context({ q }: { q: ThreadItem }) {
  if (q.kind === "app") return <span className={chip}>{q.label ? <Masked kind="app" real={q.label} /> : "App"}</span>;
  if (q.kind === "alert") return <span className={chip}>Alert: {q.label ? <MaskedText text={q.label} /> : "alert"}</span>;
  return <span className={chip}>General</span>;
}

function Thread({ q, now }: { q: ThreadItem; now: Date }) {
  const by = [q.client, q.model].filter(Boolean).join(" · ") || "AI";
  return (
    <li className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <p className="m-0 mb-1.5 whitespace-pre-wrap break-words"><MaskedText text={q.question} /></p>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px]">
        <Context q={q} />
        {q.requestedModel && <span className={`${chip} font-mono`}>{AG_PUBLIC_PREFIX}{q.requestedModel}</span>}
        <time dateTime={q.createdAt.toISOString()} className="font-mono text-ink-faint">{when(q.createdAt, now)}</time>
        {q.status === "pending" && (
          <span role="status" className="inline-flex items-center gap-1 text-ink-soft"><IconLoader2 size={14} className="animate-spin" aria-hidden />{ASK_COPY.waiting}</span>
        )}
        {q.status === "answered" && (
          <span className="text-ink-soft">Answered by {by}{q.answeredAt ? ` · ${when(q.answeredAt, now)}` : ""}</span>
        )}
        {q.status === "expired" && <span className="text-ink-faint">Expired · no answer within 7 days</span>}
      </div>
      {q.status === "answered" && q.answer && (
        <AiBox icon={<IconMessage2 size={18} aria-hidden />} meta="Written by AI, can be wrong">
          <Markdown source={q.answer} />
        </AiBox>
      )}
    </li>
  );
}
