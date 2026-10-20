import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ store: { v: null as unknown }, fail: false }));
vi.mock("@/lib/data/settings-db", () => ({
  readNotifyLangSetting: async () => {
    if (h.fail) throw new Error("db down");
    return h.store.v;
  },
}));

import { parseNotifyLang, parseNotifyLangs, readNotifyLang, readNotifyLangs, t } from "./lang";

beforeEach(() => { h.store.v = null; h.fail = false; });

describe("parseNotifyLang", () => {
  it("accepts id in any case with spaces, everything else is en", () => {
    expect(parseNotifyLang("id")).toBe("id");
    expect(parseNotifyLang("ID ")).toBe("id");
    expect(parseNotifyLang("en")).toBe("en");
    for (const bad of ["fr", null, undefined, {}, 5, ""]) expect(parseNotifyLang(bad)).toBe("en");
  });
});

describe("parseNotifyLangs", () => {
  const all = (l: string) => ({ telegram: l, discord: l, email: l });
  it("reads the old { lang } and a bare string as that language for all three channels", () => {
    expect(parseNotifyLangs({ lang: "id" })).toEqual(all("id"));
    expect(parseNotifyLangs("id")).toEqual(all("id"));
    expect(parseNotifyLangs({ lang: "en" })).toEqual(all("en"));
  });
  it("reads each channel of the new shape", () => {
    expect(parseNotifyLangs({ telegram: "id", discord: "en", email: "en" })).toEqual({ telegram: "id", discord: "en", email: "en" });
    expect(parseNotifyLangs({ telegram: "en", discord: "id", email: "id" })).toEqual({ telegram: "en", discord: "id", email: "id" });
  });
  it("turns missing or invalid parts into en", () => {
    for (const bad of [null, undefined, 5, [], {}, { lang: "fr" }]) expect(parseNotifyLangs(bad)).toEqual(all("en"));
    expect(parseNotifyLangs({ telegram: "id", discord: "fr" })).toEqual({ telegram: "id", discord: "en", email: "en" });
  });
});

describe("readNotifyLang(s)", () => {
  it("is en everywhere when nothing is saved and when the read throws", async () => {
    expect(await readNotifyLang()).toBe("en");
    h.fail = true;
    expect(await readNotifyLang()).toBe("en");
    expect(await readNotifyLangs()).toEqual({ telegram: "en", discord: "en", email: "en" });
  });
  it("no argument means telegram, and each channel reads its own, every time (no caching)", async () => {
    h.store.v = { telegram: "id", discord: "en", email: "en" };
    expect(await readNotifyLang()).toBe("id");
    expect(await readNotifyLang("telegram")).toBe("id");
    expect(await readNotifyLang("discord")).toBe("en");
    expect(await readNotifyLang("email")).toBe("en");
    h.store.v = { telegram: "en", discord: "id", email: "en" };
    expect(await readNotifyLang()).toBe("en");
    expect(await readNotifyLang("discord")).toBe("id");
  });
  it("an old { lang: id } row reads as id for every channel", async () => {
    h.store.v = { lang: "id" };
    for (const c of ["telegram", "discord", "email"] as const) expect(await readNotifyLang(c)).toBe("id");
  });
});

describe("t", () => {
  it("looks the key up in the language's table", () => {
    const table = { en: { hi: "Hello" }, id: { hi: "Halo" } };
    expect(t(table, "en", "hi")).toBe("Hello");
    expect(t(table, "id", "hi")).toBe("Halo");
  });
});
