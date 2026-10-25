import { Geist, Geist_Mono } from "next/font/google";
import type { Lang } from "@/lib/paths";
import { themeInitScript } from "@/lib/theme";
import "@/app/styles.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

// The <html> shell both root layouts share: (en) at /, (id) at /id, so each page carries the right lang attribute.
export function SiteHtml({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return (
    <html lang={lang} suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      {/* App Router root layout: a plain <head> is the documented way to add the theme script. */}
      {/* eslint-disable-next-line @next/next/no-head-element */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
