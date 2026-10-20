import { describe, expect, it } from "vitest";
import { mfaStep } from "./mfa";

describe("mfaStep", () => {
  it("lets a completed MFA session through for every role", () => {
    for (const role of ["owner", "operator", "viewer"] as const) expect(mfaStep({ role, aal: "aal2", hasVerifiedFactor: true })).toBe("ok");
  });
  it("sends owners and operators without a factor to setup", () => {
    expect(mfaStep({ role: "owner", aal: "aal1", hasVerifiedFactor: false })).toBe("setup");
    expect(mfaStep({ role: "operator", aal: undefined, hasVerifiedFactor: false })).toBe("setup");
  });
  it("asks anyone with a factor for the code", () => {
    expect(mfaStep({ role: "owner", aal: "aal1", hasVerifiedFactor: true })).toBe("challenge");
    expect(mfaStep({ role: "viewer", aal: "aal1", hasVerifiedFactor: true })).toBe("challenge");
  });
  it("does not force viewers to enrol", () => {
    expect(mfaStep({ role: "viewer", aal: "aal1", hasVerifiedFactor: false })).toBe("ok");
  });
});
