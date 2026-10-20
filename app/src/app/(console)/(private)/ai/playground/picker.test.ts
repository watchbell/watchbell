import { describe, expect, it } from "vitest";
import { initialModel, pickerOptions } from "./picker";

describe("pickerOptions: provider models first, then the enabled Antigravity models as ag/<id>", () => {
  it("lists both, provider models real-time, Antigravity via the VM", () => {
    const opts = pickerOptions(["gemini/gemini-3.8-flash"], [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }, { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }]);
    expect(opts).toEqual([
      { id: "gemini/gemini-3.8-flash", label: "gemini/gemini-3.8-flash", via: "provider" },
      { id: "ag/gemini-3.8-flash-high", label: "ag/gemini-3.8-flash-high · Gemini 3.8 Flash (High)", via: "antigravity" },
      { id: "ag/claude-sonnet-4-6", label: "ag/claude-sonnet-4-6 · Claude Sonnet 4.6", via: "antigravity" },
    ]);
  });
  it("leaves the label off when it is just the id", () => {
    expect(pickerOptions([], [{ id: "gpt-oss-120b", label: "gpt-oss-120b" }])).toEqual([{ id: "ag/gpt-oss-120b", label: "ag/gpt-oss-120b", via: "antigravity" }]);
  });
  it("only Antigravity, only providers, or nothing", () => {
    expect(pickerOptions([], [])).toEqual([]);
    expect(pickerOptions(["a/b"], []).map((o) => o.via)).toEqual(["provider"]);
  });
});

describe("initialModel", () => {
  const opts = pickerOptions(["gemini/a", "gemini/b"], [{ id: "x", label: "x" }, { id: "y", label: "y" }]);
  it("the provider default, else the first provider model (real-time first)", () => {
    expect(initialModel(opts, "gemini/b", "y")).toBe("gemini/b");
    expect(initialModel(opts, "gone/model", "y")).toBe("gemini/a");
  });
  it("without providers: the Antigravity default, else the first Antigravity model", () => {
    const ag = pickerOptions([], [{ id: "x", label: "x" }, { id: "y", label: "y" }]);
    expect(initialModel(ag, null, "y")).toBe("ag/y");
    expect(initialModel(ag, null, null)).toBe("ag/x");
    expect(initialModel(ag, null, "gone")).toBe("ag/x");
    expect(initialModel([], null, null)).toBe("");
  });
});
