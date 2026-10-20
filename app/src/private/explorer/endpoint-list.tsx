import { IconLock } from "@tabler/icons-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { OPS, TAGS } from "@/private/openapi/operations";
import { MethodChip } from "./method-chip";

// The explorer's left card: every endpoint grouped by tag, a method chip each, a lock on the docs-only ones.
export function EndpointList({ activeId }: { activeId: string }) {
  return (
    <nav aria-label="Endpoints" className="pb-2 pt-1">
      {TAGS.map((tag) => {
        const ops = OPS.filter((o) => o.tag === tag);
        if (!ops.length) return null;
        return (
          <div key={tag}>
            <div className="px-3 pb-1 pt-2.5 text-[11.5px] uppercase tracking-[.04em] text-ink-faint">{tag}</div>
            {ops.map((o) => (
              <Link
                key={o.id}
                href={`/api-docs/${o.id}`}
                title={o.summary}
                aria-current={o.id === activeId ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 px-3 py-[5px] font-mono text-[12.5px] text-ink hover:bg-hover hover:no-underline",
                  o.id === activeId && "bg-nav-active text-nav-active-text hover:bg-nav-active",
                )}
              >
                <MethodChip method={o.method} />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{o.path.startsWith("/api/v1") ? o.path.slice("/api/v1".length) : o.path}</span>
                {o.docsOnly && <IconLock size={14} aria-label="Docs only" className="ml-auto shrink-0 text-ink-faint" />}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
