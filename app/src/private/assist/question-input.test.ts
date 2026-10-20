import { describe, expect, it } from "vitest";
import { checkQuestion, QUESTION_MAX, SECRET_REFUSED } from "./question-input";

describe("checkQuestion (Ask page and POST /api/v1/ai/questions)", () => {
  it("trims and accepts 1 to 2000 characters", () => {
    expect(checkQuestion("  Which apps need attention?  ")).toEqual({ ok: true, question: "Which apps need attention?" });
    expect(checkQuestion("x".repeat(QUESTION_MAX))).toMatchObject({ ok: true });
  });
  it("refuses empty, blank, non-string and too long text", () => {
    expect(checkQuestion("")).toEqual({ ok: false, error: "Type a question first." });
    expect(checkQuestion("  \n ")).toEqual({ ok: false, error: "Type a question first." });
    expect(checkQuestion(42)).toEqual({ ok: false, error: "Type a question first." });
    expect(checkQuestion(undefined)).toEqual({ ok: false, error: "Type a question first." });
    expect(checkQuestion("x".repeat(QUESTION_MAX + 1))).toEqual({ ok: false, error: "A question can be up to 2000 characters." });
  });
  it.each([
    ["a console key", "why does wp_AbCdEf1234567890 get 401?"],
    ["a provider key", "is sk-proj_abcdef123456 still valid"],
    ["a Gemini key", "AIzaSyA1234567890abcdef"],
    ["a Groq key", "gsk_abcdef123456"],
    ["a heartbeat token", "ping hb_0123456789abcdef0123456789abcdef"],
    ["a bearer token", "curl -H 'Authorization: Bearer abcdefghijklmnop1234'"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["credentials in a URL", "postgres://admin:hunter2@db.example.com/app"],
    ["a long hex run", "token 0123456789abcdef0123456789abcdef01234567"],
  ])("refuses %s", (_n, text) => {
    expect(checkQuestion(text)).toEqual({ ok: false, error: SECRET_REFUSED });
  });
  it("keeps ordinary questions that mention keys, URLs or addresses", () => {
    for (const q of ["How do I rotate my API key?", "Is https://example.com/status up?", "What does sk-learn do?", "Mail me at owner@example.com", "password: what does that error mean?"]) {
      expect(checkQuestion(q), q).toMatchObject({ ok: true });
    }
  });
});
