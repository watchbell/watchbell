import { type Provider, PROVIDER_INFO } from "@/lib/providers/info";
import type { TestResult } from "@/lib/providers/test-connection";
export function validateAccountLabel(
  provider: Provider,
  rawLabel: string,
  existing: { labels: readonly string[]; count: number },
): { ok: true; label: string } | { ok: false; error: string } {
  const info = PROVIDER_INFO[provider];
  if (!info.multiAccount && existing.count >= 1) return { ok: false, error: `${info.name} supports one account. Replace its credential instead.` };
  const label = rawLabel.trim();
  if (!label) return { ok: false, error: "Enter a name for this account." };
  if (label.length > 40) return { ok: false, error: "Keep the name under 40 characters." };
  if (existing.labels.includes(label)) return { ok: false, error: `${info.name} already has an account called ${label}.` };
  return { ok: true, label };
}

export function credentialProblem(decrypted: string | null): string | null {
  return decrypted === null ? "Can't read the stored credential. The encryption key changed. Replace the credential." : null;
}

// What a retest does to the stored status. Only a rejected credential (or an unreadable one) marks the
// account as broken. A timeout, rate limit, outage or odd answer says nothing about the credential, so
// the status stays as it was (null = leave it alone) and the caller just reports the error.
export function statusAfterTest(test: TestResult): { status: "ok"; lastError: null } | { status: "error"; lastError: string } | null {
  if (test.ok) return { status: "ok", lastError: null };
  return test.kind === "auth" ? { status: "error", lastError: test.error } : null;
}
