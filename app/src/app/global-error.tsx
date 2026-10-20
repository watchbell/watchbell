"use client";

import { ErrorView } from "@/components/error-view";
import { ThemeKeeper } from "@/components/theme-keeper";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";

// Replaces the root layout when that layout itself fails, so it brings its own document, styles and theme.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Something went wrong</title>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-bg font-sans text-ink antialiased">
        <main className="grid min-h-screen place-items-center px-4 py-6">
          <div className="w-[460px] max-w-full">
            <ErrorView digest={error.digest} retry={retry} withSignOut />
          </div>
        </main>
        {/* Usually rendered on the client, where the init script above doesn't run (J2). */}
        <ThemeKeeper />
      </body>
    </html>
  );
}
