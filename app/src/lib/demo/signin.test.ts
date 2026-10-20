import { describe, expect, it } from "vitest";
import { PUBLISHED_DEMO_EMAIL, PUBLISHED_DEMO_PASSWORD } from "./account";
import { verifyDemoCookie } from "./cookie";
import { demoSignIn } from "./signin";

const KEY = Buffer.alloc(32, 3);
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const visitorOf = (r: ReturnType<typeof demoSignIn>) => (r.ok ? verifyDemoCookie(r.cookie, KEY, NOW) : null);

describe("demoSignIn", () => {
  it("the published account gets a new random seed on every sign-in too (ruling F)", () => {
    const seeds = [PUBLISHED_DEMO_PASSWORD, "anything else", PUBLISHED_DEMO_PASSWORD].map((password) => {
      const v = visitorOf(demoSignIn({ email: ` ${PUBLISHED_DEMO_EMAIL.toUpperCase()} `, password }, KEY, NOW));
      expect(v?.email).toBe(PUBLISHED_DEMO_EMAIL);
      expect(v?.seed).toMatch(/^[0-9a-f]{32}$/);
      return v?.seed;
    });
    expect(new Set(seeds).size).toBe(3);
  });

  it("any other valid email and any 1–200 character password sign in, with a new random seed each time", () => {
    const a = visitorOf(demoSignIn({ email: "Ana@Visitor.test", password: "x" }, KEY, NOW));
    const b = visitorOf(demoSignIn({ email: "ana@visitor.test", password: "p".repeat(200) }, KEY, NOW));
    expect(a?.email).toBe("ana@visitor.test");
    expect(b?.email).toBe("ana@visitor.test");
    expect(a?.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(a?.seed).not.toBe(b?.seed);
  });

  it("refuses an invalid or over-long email and an empty or over-long password", () => {
    for (const email of ["", "   ", "not-an-email", "a@", `${"a".repeat(250)}@x.io`]) {
      expect(demoSignIn({ email, password: "pw" }, KEY, NOW)).toEqual({ ok: false, message: "Enter a valid email address.", field: "email" });
    }
    for (const password of ["", "p".repeat(201)]) {
      expect(demoSignIn({ email: "ana@visitor.test", password }, KEY, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/^Enter a password of 1 to 200/), field: "password" });
    }
  });

  it("sends the visitor where they were heading, same-site only", () => {
    expect(demoSignIn({ email: "ana@visitor.test", password: "pw", next: "/alerts?x=1" }, KEY, NOW)).toMatchObject({ ok: true, redirectTo: "/alerts?x=1" });
    expect(demoSignIn({ email: "ana@visitor.test", password: "pw", next: "//evil.example" }, KEY, NOW)).toMatchObject({ ok: true, redirectTo: "/" });
    expect(demoSignIn({ email: "ana@visitor.test", password: "pw" }, KEY, NOW)).toMatchObject({ ok: true, redirectTo: "/" });
  });
});
