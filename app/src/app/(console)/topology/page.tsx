import { IconHierarchy3 } from "@tabler/icons-react";
import Link from "next/link";
import { buttonClass, Card, EmptyState, PageHeader } from "@/components/kit";
import { AutoRefresh } from "@/components/live";
import { DbName, Masked, MaskedText } from "@/components/alias";
import { ResourceBadge } from "@/components/resource";
import { StateIcon, Status } from "@/components/status";
import { requirePageMember } from "@/lib/auth";
import { aliasBook } from "@/lib/data/cached";
import { topologyColumns } from "@/lib/data/topology-db";
import { cn } from "@/lib/utils";
import { STATE_WORD } from "@/lib/view/labels";
import { GAP_X, GAP_Y, HEAD_H, layoutTopology, NODE_H, NODE_W, type TopoNode } from "@/lib/view/topology";

const HEADS = ["Domains", "Applications", "Databases"];
const KV = "grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px] max-[720px]:grid-cols-1 max-[720px]:gap-y-1 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-ink-soft";

// The drawer's "Open …" button names where it goes (mockup showNode).
function openLabel(n: TopoNode): string {
  if (n.kind === "app") return "Open application";
  if (n.kind === "dom") return "Open domains";
  return n.href === "/neon" ? "Open Neon" : n.href === "/firebase" ? "Open Firebase" : "Open Supabase";
}

// Screenshot mode: an app node reads app-a, a domain node its masked host (components/alias.tsx).
function NodeName({ n, inLink }: { n: TopoNode; inLink?: boolean }) {
  return n.kind === "app" ? <Masked kind="app" real={n.name} inLink={inLink} /> : <MaskedText text={n.name} inLink={inLink} />;
}

// The selected node is the ?node= search parameter, so the highlighted box, the hot lines and the drawer are all
// server-rendered and the page needs no client code.
export default async function TopologyPage({ searchParams }: { searchParams: Promise<{ node?: string }> }) {
  await requirePageMember();
  const { node } = await searchParams;
  const now = new Date();
  const cols = await topologyColumns(now, await aliasBook());
  const all = cols.flat();
  const selected = all.find((n) => n.key === node) ?? null;
  const l = layoutTopology(cols, selected?.key ?? null);
  return (
    <>
      <AutoRefresh at={now.getTime()} />
      <PageHeader
        crumbs={[{ label: "Home" }, { label: "Topology" }]}
        title="Topology"
        sub="How each domain reaches an app and which database the app uses. Domains come from Vercel; database links from each app's Edit link. Select a node to see details."
      />
      <Card flush>
        {all.length === 0 ? (
          <EmptyState icon={IconHierarchy3} title="Nothing to draw yet">
            Watch an app in Sync and its domains and database show up here.
          </EmptyState>
        ) : (
          <div className={cn("grid", selected && "min-[1001px]:grid-cols-[minmax(0,1fr)_320px]")}>
            <div className="overflow-x-auto px-6 pb-6 pt-[18px] max-[720px]:p-3.5">
              <div className="relative max-[720px]:!h-auto max-[720px]:!w-auto" style={{ width: l.width, height: l.height }}>
                <svg aria-hidden width={l.width} height={l.height} className="pointer-events-none absolute inset-0 max-[720px]:hidden">
                  {l.edges.map((e) => (
                    <path key={`${e.from}-${e.to}`} d={e.d} fill="none" strokeWidth={e.hot ? 2 : 1.5} strokeDasharray={e.bad ? "4 4" : undefined}
                      className={e.bad ? "stroke-err" : e.hot ? "stroke-brand" : "stroke-line-strong"} />
                  ))}
                </svg>
                {HEADS.map((head, col) => (
                  <div key={head} className="absolute top-0 max-[720px]:static max-[720px]:mb-4" style={{ left: col * (NODE_W + GAP_X), width: NODE_W }}>
                    <div className="flex items-center text-[12.5px] text-ink-faint max-[720px]:mb-1" style={{ height: HEAD_H }}>{head}</div>
                    <div className="flex flex-col" style={{ gap: GAP_Y }}>
                      {l.nodes.filter((p) => p.col === col).map((p) => (
                        <Link
                          key={p.key} href={`/topology?node=${encodeURIComponent(p.key)}`} scroll={false}
                          aria-current={selected?.key === p.key ? "true" : undefined}
                          className={cn(
                            "flex items-center gap-2 rounded-lg border bg-surface px-2.5 text-left hover:no-underline",
                            selected?.key === p.key ? "border-brand ring-2 ring-brand/25" : "border-line-strong hover:border-brand",
                          )}
                          style={{ height: NODE_H }}
                        >
                          <ResourceBadge kind={p.kind} />
                          <span className="min-w-0 flex-1 truncate text-ink">{p.alias ?? <NodeName n={p} inLink />}<small className="block truncate text-[11.5px] text-ink-faint"><MaskedText text={p.sub} inLink /></small></span>
                          <StateIcon state={p.state} /><span className="sr-only">{STATE_WORD[p.state]}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {selected && (
              <aside aria-label={`Details of ${selected.alias ?? selected.name}`} className="border-l border-line px-[18px] py-4 max-[1000px]:border-l-0 max-[1000px]:border-t">
                <h3 className="mb-3 flex items-center gap-2 text-[15px]"><ResourceBadge kind={selected.kind} />{selected.alias ? <DbName id={selected.key.slice(3)} name={selected.name} alias={selected.alias} /> : <NodeName n={selected} />}</h3>
                <dl className={KV}>
                  {selected.facts.map((f) => (
                    <div key={f.label} className="contents">
                      <dt>{f.label}</dt>
                      <dd className={f.mono ? "font-mono text-[12.5px]" : undefined}>{f.state ? <Status state={f.state}><MaskedText text={f.value} /></Status> : <MaskedText text={f.value} />}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 flex gap-2">
                  <Link className={buttonClass({ size: "sm" })} href={selected.href}>{openLabel(selected)}</Link>
                  <Link className={buttonClass({ size: "sm", variant: "ghost" })} href="/topology" scroll={false}>Close</Link>
                </div>
              </aside>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
