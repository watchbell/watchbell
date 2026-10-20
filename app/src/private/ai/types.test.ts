import { describe, expect, it } from "vitest";
import { AI_ALLOWED_MODELS_DEFAULT, AI_ALLOWED_MODELS_SETTING, allowedModel, isAllowedModel, normalizeModel, stripProvider } from "./types";

describe("allowed models for MCP writes (owner 07:35 + 08:45)", () => {
  it("defaults to gemini*, antigravity*, @cf/google/gemma* and claude*", () => {
    expect(AI_ALLOWED_MODELS_SETTING).toBe("ai.allowedModels");
    expect(AI_ALLOWED_MODELS_DEFAULT).toEqual(["gemini", "antigravity", "@cf/google/gemma", "claude"]);
    for (const m of ["gemini-2.5-flash", "Gemini-3-Pro", "GEMINI", "antigravity-preview-latest", "@cf/google/gemma-3-12b-it", "claude-sonnet-4-6"]) expect(isAllowedModel(m), m).toBe(true);
  });

  it("isAllowedModel is a raw prefix match: no prefix stripping, no trimming", () => {
    for (const m of ["gpt-4o", "google/gemini-2.5-flash", " gemini", "@cf/meta/llama-3", "", null, undefined]) expect(isAllowedModel(m), String(m)).toBe(false);
  });

  it("follows a configured list", () => {
    expect(isAllowedModel("llama-3", ["gemini", "llama"])).toBe(true);
    expect(isAllowedModel("gemini-2.5", [])).toBe(false);
  });

  it("allowedModel normalises to lowercase, strips a provider prefix and returns the stored form", () => {
    expect(allowedModel("Claude Opus 4.6 (Thinking)")).toBe("claude-opus-4.6-thinking");
    expect(allowedModel("google/Gemini 3.8 Flash")).toBe("google/gemini-3.8-flash");
    expect(allowedModel("cloudflare/@cf/google/gemma-3-12b-it")).toBe("cloudflare/@cf/google/gemma-3-12b-it");
    expect(allowedModel("@cf/meta/llama-3.1-8b")).toBeNull();
    expect(allowedModel("openai/gpt-4o")).toBeNull();
    expect(allowedModel("claude-sonnet-4-6", ["gemini"])).toBeNull();
    expect(normalizeModel("gemini<script>")).toBeNull();
    expect(stripProvider("@cf/google/gemma-3")).toBe("@cf/google/gemma-3");
  });
});
