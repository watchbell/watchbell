import "server-only";
import { after } from "next/server";
import { refreshStaleModelLists } from "./providers-db";

// Models, Playground and Ask call this while rendering: the page serves the stored list and, after the response, any
// custom server's list older than 10 minutes is re-detected (owner 14 Oct). Never blocks or fails the page.
export function scheduleModelRefresh(): void {
  const run = () => refreshStaleModelLists().then(() => undefined, (e: unknown) => { console.warn("model list refresh failed:", e instanceof Error ? e.name : "unknown"); });
  try {
    after(run);
  } catch {
    void run();
  }
}
