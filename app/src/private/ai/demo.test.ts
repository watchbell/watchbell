import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";

// Demo mode, AI Gateway (Task 5 of the demo plan): the seeded call metadata shows on the AI pages, and the console's AI
// answers with the canned demo reply without calling any provider. The OpenAI-compatible endpoint is /api/v1, which the
// demo's proxy answers 404 (lib/demo/proxy.ts); reached anyway, it still wants a console key first.
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { seedDemoDb } from "@/lib/demo/seed";
import { DEMO_AI_REPLY } from "@/lib/demo/simulate";
import { ports } from "@/private/assist/ports";
import { complete, handleChat } from "./gateway";
import { usageLog } from "./views-db";

const SAVED = process.env.WATCHBELL_MODE;
const fetchSpy = vi.fn(async () => new Response("{}"));
const realFetch = globalThis.fetch;
let client: PGlite;

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  await seedDemoDb(db, "9f8e7d6c5b4a39281706f5e4d3c2b1a0", new Date(Date.now() - 60_000), "visitor@example.com");
  h.db = db;
}, 120_000);
afterAll(async () => {
  await client.close();
});
beforeEach(() => {
  process.env.WATCHBELL_MODE = "demo";
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (SAVED === undefined) delete process.env.WATCHBELL_MODE;
  else process.env.WATCHBELL_MODE = SAVED;
});

describe("demo: AI Gateway", () => {
  it("shows the seeded call log", async () => {
    const page = await usageLog({}, 1);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.kind === "console" && r.client === "Watchbell console")).toBe(true);
  });

  it("answers the console's AI with the canned reply, no request", async () => {
    expect(await ports.provider()).toEqual({ name: "Demo", model: "demo" });
    expect(await complete([{ role: "user", content: "Why is my app slow?" }], { purpose: "ask-ai" })).toMatchObject({ text: DEMO_AI_REPLY, model: "demo" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the chat endpoint, reached past the proxy, checks the console key before anything else", async () => {
    const res = await handleChat(new Request("https://demo.example/api/v1/ai/chat/completions", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
