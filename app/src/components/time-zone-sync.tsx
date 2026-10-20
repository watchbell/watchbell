"use client";

import { setBrowserTimeZone } from "@/lib/time";

// The browser has no WATCHBELL_TIMEZONE, so the console layout passes the server's zone down and this sets it before
// any client component below it renders a time (React renders this, a leaf placed first, before its siblings). On the
// server it does nothing: there lib/time.ts reads the variable itself.
export function TimeZoneSync({ zone }: { zone: string }) {
  setBrowserTimeZone(zone);
  return null;
}
