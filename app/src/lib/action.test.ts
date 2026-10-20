import { redirect } from "next/navigation";
import { describe, expect, it } from "vitest";
import { AuthError, runGuarded } from "./action";

const member = { id: "m1", userId: "u1", email: "a@example.com", role: "operator" as const };

describe("runGuarded", () => {
  it("passes the member through", async () => {
    const result = await runGuarded("operator", async (m) => ({ ok: true, message: m.email }), { requireActionMember: async () => member });
    expect(result).toEqual({ ok: true, message: "a@example.com" });
  });

  it.each([
    ["signed-out", "Your session ended. Sign in again."],
    ["not-member", "Your email isn't on this console."],
    ["forbidden", "You don't have permission to do that."],
    ["mfa", "Confirm your sign-in with your authenticator code first."],
  ] as const)("turns %s into a readable error", async (reason, error) => {
    const result = await runGuarded("owner", async () => ({ ok: true }), {
      requireActionMember: async () => {
        throw new AuthError(reason);
      },
    });
    expect(result).toEqual({ ok: false, error });
  });

  it("hides unexpected errors behind a generic message", async () => {
    const result = await runGuarded("viewer", async () => {
      throw new Error("db password is hunter2");
    }, { requireActionMember: async () => member });
    expect(result).toEqual({ ok: false, error: "Something went wrong. Try again." });
  });

  it("lets Next.js control-flow errors such as redirect() through", async () => {
    await expect(
      runGuarded("viewer", async () => redirect("/x"), { requireActionMember: async () => member }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });
});
