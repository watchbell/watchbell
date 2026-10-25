import type { Metadata } from "next";
import { SiteHtml } from "@/components/SiteHtml";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Watchbell", template: "%s · Watchbell" },
};

export default function IndonesianLayout({ children }: { children: React.ReactNode }) {
  return <SiteHtml lang="id">{children}</SiteHtml>;
}
