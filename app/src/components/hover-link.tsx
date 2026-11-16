"use client";

import Link from "next/link";
// The router as next/link itself reads it: from the context, without throwing where no app router is mounted (tests
// render components on their own).
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { type ComponentProps, useContext, useRef } from "react";

// 1.8.1: a next/link that asks for its page once, when the pointer, keyboard focus or a touch reaches it. The app
// renders ~30 links on every page; Next's default prefetch-in-view meant ~40 server renders per page and 64 after a
// workspace switch (measured 16 Nov), each a pooler slot on Vercel.
// Final review C1: Next's own prefetch is never switched on, not even after a hover: a link with prefetch on joins
// Next's list of visible links, which is fetched again on every refresh (60 s), server action and navigation for the
// rest of the session. router.prefetch() is a one-off. Navigation itself is unchanged.
type Props = Omit<ComponentProps<typeof Link>, "prefetch">;

export function HoverLink({ onMouseEnter, onFocus, onTouchStart, ...props }: Props) {
  const router = useContext(AppRouterContext);
  const asked = useRef(false);
  const ask = () => {
    if (asked.current || !router || typeof props.href !== "string") return;
    asked.current = true;
    router.prefetch(props.href);
  };
  return (
    <Link
      {...props}
      prefetch={false}
      onMouseEnter={(e) => { ask(); onMouseEnter?.(e); }}
      onFocus={(e) => { ask(); onFocus?.(e); }}
      onTouchStart={(e) => { ask(); onTouchStart?.(e); }}
    />
  );
}
