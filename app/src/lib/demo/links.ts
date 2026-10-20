import { isDemo } from "@/lib/mode";

// Whether the console may link out to the sites, deployments, repositories and dashboards it shows. In demo every one of
// those is made up (the seed uses the reserved .example TLD and a made-up GitHub organisation), so the demo shows them as
// plain text and a visitor can never click through to a third party. Cloud and self-host link as always.
// Server-side only: it reads WATCHBELL_MODE, which a client bundle doesn't have, so client components get the result as
// a prop (a null href) instead of calling this.
export function outboundLinks(source: Record<string, string | undefined> = process.env): boolean {
  return !isDemo(source);
}
