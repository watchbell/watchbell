import { describe, expect, it } from "vitest";
import { LOCAL_URL, PROVIDER_SHORTCUTS, validateForm } from "./presets";

// Watchbell 1.8.6: Bring your own key › shortcuts that fill the custom OpenAI-compatible form. No new adapter.
describe("PROVIDER_SHORTCUTS", () => {
  it("are Ollama (local, no key, self-host only) and DeepSeek (public, with a key)", () => {
    expect(PROVIDER_SHORTCUTS).toEqual([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", key: false, selfhostOnly: true },
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", key: true, selfhostOnly: false },
    ]);
  });

  it("DeepSeek's filled form is valid on cloud and self-host", () => {
    const form = { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "not-a-real-key" };
    expect(validateForm("custom", form, false)).toMatchObject({ ok: true, value: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" } });
    expect(validateForm("custom", form, true)).toMatchObject({ ok: true });
  });

  it("Ollama's filled form needs no key on self-host, and is refused on cloud with the reason", () => {
    const form = { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "" };
    expect(validateForm("custom", form, true)).toMatchObject({ ok: true, value: { secret: { apiKey: "", baseUrl: "http://127.0.0.1:11434/v1" } } });
    expect(validateForm("custom", form, false)).toMatchObject({ ok: false, fieldErrors: { baseUrl: LOCAL_URL } });
  });
});
