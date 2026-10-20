import { describe, expect, it } from "vitest";
import { normalizeCredential } from "./normalize";

const sa = JSON.stringify({ type: "service_account", project_id: "nova-wallet", client_email: "ops@nova-wallet.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE " + "KEY-----\nabc\n-----END PRIVATE KEY-----\n" });

describe("normalizeCredential", () => {
  it.each([
    ["  vcp_abcdefghijklmnopqrstuvwx  \n", "vcp_abcdefghijklmnopqrstuvwx"],
    ['"vcp_abcdefghijklmnopqrstuvwx"', "vcp_abcdefghijklmnopqrstuvwx"],
    ["Bearer vcp_abcdefghijklmnopqrstuvwx", "vcp_abcdefghijklmnopqrstuvwx"],
  ])("cleans pasted token %j", (raw, value) => {
    expect(normalizeCredential("vercel", raw)).toEqual({ ok: true, value });
  });

  it("rejects an empty or too-short token", () => {
    expect(normalizeCredential("neon", "   ")).toEqual({ ok: false, error: "Paste the API key." });
    expect(normalizeCredential("neon", "abc")).toEqual({ ok: false, error: "That's too short for an API key." });
  });

  it("accepts a service account JSON and rejects anything else", () => {
    expect(normalizeCredential("firebase", `\n${sa}\n`)).toEqual({ ok: true, value: sa });
    expect(normalizeCredential("firebase", "{not json")).toEqual({ ok: false, error: "Paste the whole JSON file. It needs client_email and private_key." });
  });
});
