import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createElement, type ReactNode } from "react";
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
// The drawer is a portal that only renders when open; here each tile renders its drawer's body inline (and says
// whether the page asked it to open), so the page's markup can be checked.
vi.mock("@/app/(console)/connections/provider-drawer", () => ({
  ProviderDrawer: ({ name, line, defaultOpen, children }: { name: string; line: { text: string }; defaultOpen?: boolean; children: ReactNode }) =>
    createElement("div", { "data-tile": name, "data-open": defaultOpen ? "yes" : "no" }, createElement("b", null, line.text), children),
}));
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

const render = async (provider?: string) => renderToStaticMarkup(await ConnectionsPage(provider ? { searchParams: Promise.resolve({ provider }) } : undefined));

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

describe("Connections grid (1.2)", () => {
  it("shows the providers as tiles grouped by section, connected ones with their line, Drive under Manage", async () => {
    process.env.WATCHPOST_MODE = "demo";
    const out = await render();
    const sections = [...out.matchAll(/data-section="(\w+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(["hosting", "database", "devops", "manage"]);
    const tiles = [...out.matchAll(/data-tile="([^"]+)" data-open="\w+"><b>([^<]+)<\/b>/g)].map((m) => [m[1], m[2]]);
    expect(tiles).toEqual([
      ["Vercel", "Connected"], ["Cloudflare", "Connected"],
      ["Supabase", "Connected"], ["Neon", "Connected"], ["Firebase", "Connected"], ["Turso", "Connected"], ["Upstash", "Connected"],
      ["GitHub", "Not connected"], ["GitHub (PR write)", "Not connected"],
      ["Google Drive", expect.any(String)],
    ]);
  });

  it("?provider= opens that provider's drawer and no other", async () => {
    process.env.WATCHPOST_MODE = "demo";
    const out = await render("neon");
    expect([...out.matchAll(/data-tile="([^"]+)" data-open="yes"/g)].map((m) => m[1])).toEqual(["Neon"]);
    expect((await render("nope")).includes('data-open="yes"')).toBe(false);
  });
});
