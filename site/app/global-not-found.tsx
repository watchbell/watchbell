import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { SiteHtml } from "@/components/SiteHtml";

// The site has two root layouts ((en) and (id)), so its 404 is a global one (next.config.ts: experimental.globalNotFound).
export const metadata: Metadata = {
  title: "Page not found · Watchbell",
  robots: { index: false },
};

export default function GlobalNotFound() {
  return (
    <SiteHtml lang="en">
      <Header lang="en" otherHref="/id" />
      <main className="handoff" id="main">
        <div className="wrap">
          <span className="eyebrow">404</span>
          <h1>This page isn&apos;t here.</h1>
          <p>
            Try the <Link href="/">home page</Link> or the <Link href="/docs">documentation</Link>.{" "}
            <span lang="id">
              Halaman ini tidak ada; coba <Link href="/id">beranda</Link> atau <Link href="/id/docs">dokumentasi</Link>.
            </span>
          </p>
        </div>
      </main>
      <Footer lang="en" />
    </SiteHtml>
  );
}
