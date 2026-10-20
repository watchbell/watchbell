import { describe, expect, it } from "vitest";
import { baseName, type DbOption, dbHref, dbProvider, orderOptions, suggestDatabase } from "./links";

const opt = (id: string, name: string, kind: DbOption["kind"] = "supabase_project"): DbOption => ({ id, name, kind, account: "utama", region: null, ident: null });

describe("baseName", () => {
  it.each([
    ["web-Quillpad", "quillpad"], ["webs-ticketer", "ticketer"], ["portfolio-site", "portfolio"],
    ["acme-shop", "acmeshop"], ["orbit-old", "orbitold"], ["nova_wallet", "novawallet"],
  ])("%s → %s", (raw, out) => expect(baseName(raw)).toBe(out));
});

describe("suggestDatabase", () => {
  const options = [opt("s1", "portfolio"), opt("s2", "acme-shop"), opt("s3", "quillpad"), opt("s4", "orbit-old"),
    opt("n1", "ticketer", "neon_project"), opt("f1", "orbit", "firestore"), opt("f2", "nova-wallet", "firestore")];
  it("matches the same base name on any provider", () => {
    expect(suggestDatabase("acme-shop", options)).toBe("s2");
    expect(suggestDatabase("web-Quillpad", options)).toBe("s3");
    expect(suggestDatabase("webs-ticketer", options)).toBe("n1");
    expect(suggestDatabase("portfolio-site", options)).toBe("s1");
    expect(suggestDatabase("web-orbit", options)).toBe("f1"); // exact beats "orbit-old"
  });
  it("suggests nothing when two databases fit equally, or nothing fits", () => {
    expect(suggestDatabase("acme-shop", [opt("a", "acme-shop"), opt("b", "acmeshop", "neon_project")])).toBeNull();
    expect(suggestDatabase("game-dev", options)).toBeNull();
  });
  it("uses a containing name only when it is unique and at least 4 characters", () => {
    expect(suggestDatabase("nova-wallet-site", options)).toBe("f2");
    expect(suggestDatabase("ai", [opt("x", "ai-dev")])).toBeNull();
  });
});

describe("dbProvider / dbHref", () => {
  it("maps each database kind to its provider and page", () => {
    expect([dbProvider("supabase_project"), dbProvider("neon_project"), dbProvider("firestore")]).toEqual(["supabase", "neon", "firebase"]);
    expect([dbHref("supabase_project"), dbHref("neon_project"), dbHref("firestore")]).toEqual(["/supabase", "/neon", "/firebase"]);
  });
});

describe("orderOptions", () => {
  const list = [opt("z", "zeta"), opt("t1", "ticketer"), opt("m", "monitoring"), opt("t2", "dbTicketer"), opt("t3", "db_ticketer", "neon_project"), opt("t4", "ticketer", "neon_project"), opt("a", "alpha")];
  const ids = (xs: DbOption[]) => xs.map((o) => o.id);
  it("puts the suggested database first, then the current one, then same-name matches, then the rest in their order", () => {
    expect(ids(orderOptions("webs-ticketer", list, "t4", "a"))).toEqual(["t4", "a", "t1", "t2", "t3", "z", "m"]);
  });
  it("still floats name matches up when nothing is suggested (two 'ticketer'), exact before partial", () => {
    expect(ids(orderOptions("webs-ticketer", list, null, null))).toEqual(["t1", "t4", "t2", "t3", "z", "m", "a"]);
  });
  it("keeps the order when nothing matches and doesn't change the input", () => {
    const copy = [...list];
    expect(ids(orderOptions("game-dev", list, null, null))).toEqual(ids(list));
    expect(list).toEqual(copy);
  });
});
