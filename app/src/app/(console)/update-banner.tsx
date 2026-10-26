import { ExternalLink } from "@/components/external-link";
import { Banner } from "@/components/kit";
import { type UpdateNotice, whatsNewUrl } from "@/lib/self-update";
import { WhatsNewDismiss } from "./whats-new-dismiss";

// 1.2.3 (owner 25 Oct: how are updates announced?): self-hosted, the owner sees when npm has a newer Watchbell, and
// once after an update, What's new. The layout reads the notice; members never get it.
export function UpdateBanner({ notice }: { notice: UpdateNotice }) {
  if (!notice) return null;
  if (notice.kind === "update") {
    return (
      <Banner tone="info" title={`Watchbell ${notice.latest} is available (this is ${notice.running})`}>
        Update with <code className="font-mono text-[12.5px]">watchbell update</code> in a terminal on the machine that runs it, then start it again.{" "}
        <ExternalLink href={whatsNewUrl(notice.latest)} target="_blank" rel="noopener">What&apos;s new</ExternalLink>
      </Banner>
    );
  }
  return (
    <Banner tone="info" title={`Updated to Watchbell ${notice.version}`} action={<WhatsNewDismiss />}>
      <ExternalLink href={whatsNewUrl(notice.version)} target="_blank" rel="noopener">See what&apos;s new in {notice.version}</ExternalLink>
    </Banner>
  );
}
