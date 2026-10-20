import { describe, expect, it } from "vitest";
import { explorerModels, type ModelRowLike } from "./page-models";

const row = (publicId: string, o: Partial<ModelRowLike> = {}): ModelRowLike => ({
  publicId, enabled: true, providerEnabled: true, upstream: publicId.split("/")[1], manual: false, providerKind: "custom", ...o,
});
const off = { connected: false, ids: ["gemini-3.8-flash-high"] };

describe("explorerModels (the explorer page's model data)", () => {
  it("lists enabled provider models with the console default first, marked default", () => {
    const m = explorerModels({ rows: [row("test/prrojects"), row("test/combo-new"), row("test/gpt-x")], defaultModel: "test/combo-new", ag: off });
    expect(m.defaultModel).toBe("test/combo-new");
    expect(m.options).toEqual([
      { id: "test/combo-new", isDefault: true, async: false },
      { id: "test/prrojects", isDefault: false, async: false },
      { id: "test/gpt-x", isDefault: false, async: false },
    ]);
  });
  it("leaves out switched-off models, models of a switched-off provider and models the gateway doesn't offer", () => {
    const m = explorerModels({
      rows: [
        row("test/combo-new"), row("test/off", { enabled: false }), row("old/x", { providerEnabled: false }),
        row("gemini/embedding-001", { providerKind: "gemini", upstream: "models/text-embedding-004" }),
      ],
      defaultModel: "test/combo-new", ag: off,
    });
    expect(m.options.map((o) => o.id)).toEqual(["test/combo-new"]);
  });
  it("hides ag/ models while Antigravity isn't connected and lists them (async) after the provider models when it is", () => {
    const rows = [row("test/combo-new")];
    expect(explorerModels({ rows, defaultModel: "test/combo-new", ag: off }).options.some((o) => o.id.startsWith("ag/"))).toBe(false);
    const on = explorerModels({ rows, defaultModel: "test/combo-new", ag: { connected: true, ids: ["gemini-3.8-flash-high"] } });
    expect(on.options).toEqual([
      { id: "test/combo-new", isDefault: true, async: false },
      { id: "ag/gemini-3.8-flash-high", isDefault: false, async: true },
    ]);
  });
  it("falls back to the first enabled provider model when the default setting is missing or switched off", () => {
    expect(explorerModels({ rows: [row("test/a"), row("test/b")], defaultModel: null, ag: off }).defaultModel).toBe("test/a");
    const m = explorerModels({ rows: [row("test/a"), row("test/b")], defaultModel: "gemini/gemini-3.8-flash", ag: off });
    expect(m.defaultModel).toBe("test/a");
    expect(m.options[0]).toEqual({ id: "test/a", isDefault: true, async: false });
  });
  it("has no default and no options when nothing is on (an ag/ model is never the chat default)", () => {
    expect(explorerModels({ rows: [], defaultModel: "test/combo-new", ag: off })).toEqual({ defaultModel: null, options: [] });
    const agOnly = explorerModels({ rows: [], defaultModel: null, ag: { connected: true, ids: ["x"] } });
    expect(agOnly.defaultModel).toBeNull();
    expect(agOnly.options).toEqual([{ id: "ag/x", isDefault: false, async: true }]);
  });
});
