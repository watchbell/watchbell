import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";

// Demo: the seeded accounts hold a placeholder instead of a credential, so Connections shows them as demo accounts, not
// as "Can't read the stored credential" (which is what cloud shows for the same row).
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/auth", () => ({ requireActionMember: vi.fn(), pageGate: async () => ({ ok: true, member: { id: "m", userId: "u", email: "visitor@example.com", role: "owner" } }) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), SITE_URL: "https://demo.example" }) }));
vi.mock("@/app/(console)/connections/schedulers-card", () => ({ SchedulersCard: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/connections", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { seedDemoDb } from "@/lib/demo/seed";
import ConnectionsPage from "./page";

const SAVED = process.env.WATCHPOST_MODE;
let client: PGlite;
beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  await seedDemoDb(db, "feedface00feedface00feedface0000", new Date(), "visitor@example.com");
  h.db = db;
}, 120_000);
afterAll(async () => {
  await client.close();
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.WATCHPOST_MODE;
  else process.env.WATCHPOST_MODE = SAVED;
});

const render = async () => renderToStaticMarkup(await ConnectionsPage());

describe("Connections in demo", () => {
  it("shows every seeded account as a demo account, with no attention banner", async () => {
    process.env.WATCHPOST_MODE = "demo";
    const out = await render();
    expect(out.match(/Demo account/g)?.length).toBe(7); // Vercel, Supabase, Neon, Firebase, Turso, Upstash, Cloudflare
    expect(out).not.toContain("Can&#x27;t read");
    expect(out).not.toContain("need attention");
  });

  it("outside demo the same placeholder reads as an unreadable credential (unchanged behaviour)", async () => {
    delete process.env.WATCHPOST_MODE;
    const out = await render();
    expect(out).not.toContain("Demo account");
    expect(out).toContain("need attention");
  });
});
