import { isDemo } from "@/lib/mode";

// Demo mode's answers for what would reach a real provider. Nothing here touches the database or the network: the
// callers that write a simulated result (Check now, Refresh now, an approved proposal) write it to the visitor's own
// database through their usual code. Cheap to import (server actions, lib/action.ts).
//
// Where the demo is enforced:
// - runGuarded (lib/action.ts) refuses EVERY guarded server action in demo unless it declares itself demo-safe ("local":
//   it only reads or writes the visitor's database, or a simulated variant). New actions are refused by default.
// - The outbound fetch guard (fetch-guard.ts) rejects any non-same-origin request with this same message (DemoUnavailable);
//   runGuarded turns that error into this message too, should an allowed action still reach for the network.
// - Telegram, Discord and Resend senders and the console's own AI answer without a request (see their modules).
// - Route handlers are not behind runGuarded, so each is decided on its own. The proxy (proxy.ts demoRouteRule) answers
//   404 for the routes the demo doesn't have (pings, the runner, /api/v1 except openapi.json, schedulers, the Telegram
//   webhook, the Supabase and Google sign-in callbacks, /setup) and 401 for any other API route without a visitor; the
//   scheduler and webhook routes also answer 404 themselves (demoRouteGone). Of the signed-in routes, the office's
//   read-only GETs its page polls (state, proposals, reports, dev notes) run on the visitor's database, and deciding a
//   proposal runs the simulated approval (private/actions/proposals-run.ts); every other one (Ask, Patrol, a Dev note
//   request, marking reports read, /api/status) answers 403 with this message (demoRouteRefused).

export const DEMO_UNAVAILABLE = "Not available in the demo";

// What the console's own AI (Ask AI, Playground, summaries) answers in demo.
export const DEMO_AI_REPLY = "This is the Watchbell demo, so no AI model was asked. In your own install, this answer comes from the AI provider you connect under AI Gateway.";

// A refusal from the demo: thrown by the fetch guard, or by code that refuses outright.
export class DemoUnavailable extends Error {
  constructor() {
    super(DEMO_UNAVAILABLE);
    this.name = "DemoUnavailable";
  }
}

export function isDemoRefusal(e: unknown, source: Record<string, string | undefined> = process.env): boolean {
  return isDemo(source) && e instanceof Error && e.message === DEMO_UNAVAILABLE;
}

// For a route that must not run in demo (schedulers, webhooks): 404, as if it didn't exist. Null outside demo.
export function demoRouteGone(source: Record<string, string | undefined> = process.env): Response | null {
  return isDemo(source) ? Response.json({ error: "Not found" }, { status: 404 }) : null;
}

// For a signed-in route the demo doesn't run (it would reach a provider or isn't part of the demo): 403 with
// DEMO_UNAVAILABLE, never cached. Null outside demo.
export function demoRouteRefused(source: Record<string, string | undefined> = process.env): Response | null {
  return isDemo(source) ? Response.json({ error: DEMO_UNAVAILABLE }, { status: 403, headers: { "Cache-Control": "no-store" } }) : null;
}

// A made-up passing HTTP check (Check now in demo): the expected status, a plausible latency. `rand` is [0, 1).
export function simulatedCheck(expectedStatus: number, rand: () => number = Math.random): { ok: true; statusCode: number; latencyMs: number; error: null } {
  return { ok: true, statusCode: expectedStatus, latencyMs: 90 + Math.round(rand() * 260), error: null };
}

export const SIMULATED_NOTE = "Simulated in the demo: nothing was sent to a provider.";
