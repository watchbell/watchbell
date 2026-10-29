import { describe, expect, it, vi } from "vitest";

vi.mock("./env-actions", () => ({ envCheckAction: vi.fn() }));

import { envFindingText } from "./env-card";

describe("envFindingText", () => {
  it("says what each finding means, in plain words", () => {
    expect(envFindingText({ kind: "missing-production", key: "RESEND_API_KEY" })).toBe("RESEND_API_KEY is in .env.example but not set for Production");
    expect(envFindingText({ kind: "preview-only", key: "BETA" })).toBe("BETA is set for Preview or Development only");
    expect(envFindingText({ kind: "public-secret", key: "NEXT_PUBLIC_X_SECRET" })).toBe("NEXT_PUBLIC_X_SECRET is sent to the browser (NEXT_PUBLIC_) but its name looks secret");
    expect(envFindingText({ kind: "not-in-example", key: "OLD_ID" })).toBe("OLD_ID is set for Production but not listed in .env.example");
  });
});
