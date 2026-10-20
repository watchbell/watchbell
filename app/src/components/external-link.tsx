import type { ComponentProps } from "react";
import { outboundLinks } from "@/lib/demo/links";

// A link out of the console (a live site, a repository, a provider dashboard): an <a> in cloud and self-host, the same
// content as plain text in demo, where every such target is made up (lib/demo/links.ts). A server component: client
// components take a null href from their server parent instead.
export function ExternalLink({ href, children, className, ...rest }: ComponentProps<"a"> & { href: string }) {
  if (!outboundLinks()) return <span className={className}>{children}</span>;
  return <a href={href} className={className} {...rest}>{children}</a>;
}
