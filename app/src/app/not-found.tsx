import Link from "next/link";
import { BellMark } from "@/components/brand/bell-mark";
import { buttonClass } from "@/components/kit";

// 1.2.3 (UI audit C6): a mistyped address showed Next's bare "404 · This page could not be found". This one says the
// same in plain words and leads back. It sits outside the console layout, so it needs no session.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-[480px] flex-col items-center justify-center gap-3 px-4 text-center">
      <BellMark size={36} />
      <h1 className="m-0 text-[22px]">Nothing rings here</h1>
      <p className="m-0 text-ink-soft">There&apos;s no page at this address. It may have moved, or the link has a typo.</p>
      <Link href="/" className={buttonClass({ variant: "primary", size: "sm" })}>Back to Watchbell</Link>
    </main>
  );
}
