import { describe, expect, it } from "vitest";
import { logCause, safeError } from "./safe-error";

describe("safeError", () => {
  it("keeps only the first line and caps the length", () => {
    expect(safeError(new Error("Failed query: insert into x\nparams: a,b"))).toBe("Failed query: insert into x");
    expect(safeError(new Error("x".repeat(500))).length).toBe(201);
  });
  it("hides bearer tokens", () => {
    expect(safeError(new Error("bad header Bearer abc123def456"))).toBe("bad header Bearer [hidden]");
  });
  it("copes with non-errors and empty messages", () => {
    expect(safeError("boom")).toBe("failed");
    expect(safeError(new Error(""))).toBe("failed");
  });
});

describe("safeError with a cause", () => {
  it("reports the driver's message instead of drizzle's SQL", () => {
    const e = Object.assign(new Error("Failed query: select * from ops.monitors\nparams: x"), { cause: new Error("permission denied for table monitors") });
    expect(safeError(e)).toBe("permission denied for table monitors");
  });
  it("ignores a cause that is not an Error", () => {
    expect(safeError(Object.assign(new Error("plain"), { cause: "text" }))).toBe("plain");
  });
});

describe("logCause (warn lines of the selfhost scheduler and poller)", () => {
  it("is safeError's first line, also hiding a Telegram bot token and URL credentials", () => {
    expect(logCause(new Error("fetch https://api.telegram.org/bot123456:AAbb-cc_DD/getUpdates failed\nmore"))).toBe("fetch https://api.telegram.org/bot[hidden]/getUpdates failed");
    expect(logCause(new Error("connect postgres://postgres.ref:s3cret@aws-0.pooler.supabase.com:6543/postgres refused"))).toBe("connect postgres://[hidden]@aws-0.pooler.supabase.com:6543/postgres refused");
    expect(logCause(Object.assign(new Error("Failed query: x"), { cause: new Error("ECONNREFUSED") }))).toBe("ECONNREFUSED");
    expect(logCause("nope")).toBe("failed");
  });
});
