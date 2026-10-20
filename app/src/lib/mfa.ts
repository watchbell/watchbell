import type { Role } from "@/lib/roles";

export type MfaStep = "ok" | "setup" | "challenge";

// Owners and operators can change infrastructure, so their sessions must be aal2 (authenticator code).
// Anyone who has a verified factor must use it; viewers are not forced to enrol.
export function mfaStep(input: { role: Role; aal: string | undefined; hasVerifiedFactor: boolean }): MfaStep {
  if (input.aal === "aal2") return "ok";
  if (input.hasVerifiedFactor) return "challenge";
  return input.role === "owner" || input.role === "operator" ? "setup" : "ok";
}
