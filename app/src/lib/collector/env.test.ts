import { describe, expect, it } from "vitest";
import { parseCollectorEnv } from "./env";

const valid = { COLLECTOR_SECRET: "c".repeat(40), CRON_SECRET: "v".repeat(24), QSTASH_CURRENT_SIGNING_KEY: "sig_current_123", QSTASH_NEXT_SIGNING_KEY: "sig_next_45678" };
describe("parseCollectorEnv", () => {
  it("accepts complete scheduler settings", () => {
    expect(parseCollectorEnv(valid).COLLECTOR_SECRET).toHaveLength(40);
  });
  it("rejects a short collector secret and names the key without its value", () => {
    expect(() => parseCollectorEnv({ ...valid, COLLECTOR_SECRET: "short" })).toThrow(/COLLECTOR_SECRET/);
    expect(() => parseCollectorEnv({ ...valid, COLLECTOR_SECRET: "short" })).not.toThrow(/short/);
  });
  it("in selfhost the QStash keys are optional but the secrets are not", () => {
    const selfhost = { WATCHPOST_MODE: "selfhost", COLLECTOR_SECRET: valid.COLLECTOR_SECRET, CRON_SECRET: valid.CRON_SECRET };
    const env = parseCollectorEnv(selfhost);
    expect(env.QSTASH_CURRENT_SIGNING_KEY).toBe("");
    expect(env.QSTASH_NEXT_SIGNING_KEY).toBe("");
    expect(() => parseCollectorEnv({ ...selfhost, CRON_SECRET: undefined })).toThrow(/CRON_SECRET/);
  });
  it("in cloud the QStash keys stay required", () => {
    expect(() => parseCollectorEnv({ COLLECTOR_SECRET: valid.COLLECTOR_SECRET, CRON_SECRET: valid.CRON_SECRET })).toThrow(/QSTASH_CURRENT_SIGNING_KEY/);
  });
});
