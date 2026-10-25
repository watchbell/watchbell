import { IconExternalLink } from "@tabler/icons-react";
import { MaskedText } from "@/components/alias";
import { Tag } from "@/components/kit";
import type { DomainLines } from "@/lib/view/app-domains";

// The Details card's domains (1.2.1): the primary first, the other attached ones, then former ones muted and unlinked.
// One domain renders exactly as the single "Domain" row did. `link` is false in the demo, where the hosts are made up.
export function DomainsCell({ data, link }: { data: DomainLines; link: boolean }) {
  return (
    <>
      {data.lines.map((l) => (
        <div key={l.name} className={l.tag === "former" ? "text-ink-faint" : undefined}>
          {link && l.tag !== "former" ? (
            <a href={`https://${l.name}`} target="_blank" rel="noreferrer"><MaskedText text={l.name} inLink /> <IconExternalLink size={14} aria-hidden className="inline align-[-2px]" /></a>
          ) : <MaskedText text={l.name} />}
          {l.tag && <> <Tag>{l.tag === "redirect" && l.target ? <>→ <MaskedText text={l.target} /></> : l.tag}</Tag></>}
        </div>
      ))}
      {data.more > 0 && <div className="text-ink-faint">+{data.more} more</div>}
    </>
  );
}
