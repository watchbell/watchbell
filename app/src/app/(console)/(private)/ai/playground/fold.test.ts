import { describe, expect, it } from "vitest";
import { PLAYGROUND_COPY } from "@/lib/copy/edition";
import { AG_HINT, foldQuestion, turnsOf, viaOf } from "./fold";

describe("the view's helpers", () => {
  it("the hint says the answer comes from the VM and takes a while", () => {
    expect(AG_HINT).toBe(PLAYGROUND_COPY.hint); // the edition words it (edition.extras.test.ts)
  });
  it("viaOf: how a picked model answers; an id that isn't offered goes the provider way", () => {
    const opts = [{ id: "gemini/a", label: "gemini/a", via: "provider" as const }, { id: "ag/x", label: "ag/x", via: "antigravity" as const }];
    expect(viaOf(opts, "ag/x")).toBe("antigravity");
    expect(viaOf(opts, "gemini/a")).toBe("provider");
    expect(viaOf(opts, "")).toBe("provider");
  });
});

describe("turnsOf: question/answer pairs of the chat so far", () => {
  it("pairs each question with the answer that follows it; an unanswered question is left out", () => {
    expect(turnsOf([
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
      { role: "user", content: "Q2 (failed)" },
      { role: "user", content: "Q3" }, { role: "assistant", content: "A3" },
      { role: "user", content: "Q4" },
    ])).toEqual([{ q: "Q1", a: "A1" }, { q: "Q3", a: "A3" }]);
  });
});

describe("foldQuestion: earlier turns folded into the one question Antigravity gets", () => {
  it("no history: the question as typed (trimmed)", () => {
    expect(foldQuestion([], "  Which apps are down?  ")).toBe("Which apps are down?");
  });
  it("folds earlier turns in order, then the new question", () => {
    expect(foldQuestion([{ q: "Which apps are down?", a: "**web-a** is down." }], "Why?")).toBe(
      "Earlier in this chat:\nQ: Which apps are down?\nA: **web-a** is down.\n\nNow: Why?",
    );
  });
  it("keeps only the last 4 turns", () => {
    const turns = [1, 2, 3, 4, 5, 6].map((i) => ({ q: `q${i}`, a: `a${i}` }));
    const out = foldQuestion(turns, "next");
    expect(out).not.toContain("q2");
    expect(out).toContain("Q: q3\nA: a3\nQ: q4");
    expect(out.endsWith("Now: next")).toBe(true);
  });
  it("puts each turn on one line pair (newlines in answers become spaces) and clips long ones", () => {
    const out = foldQuestion([{ q: "list\nthem", a: `- one\n- two\n${"z".repeat(900)}` }], "ok?");
    expect(out).toContain("Q: list them\nA: - one - two zz");
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(2000);
  });
  it("stays within 2000 characters by dropping the oldest turns first", () => {
    const turns = [1, 2, 3, 4].map((i) => ({ q: `${i}`.repeat(400), a: `${i}`.repeat(900) }));
    const out = foldQuestion(turns, "x".repeat(300));
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("4444");
    expect(out).not.toContain("1111");
    expect(out.endsWith(`Now: ${"x".repeat(300)}`)).toBe(true);
  });
  it("a question that leaves no room for history goes alone", () => {
    const q = "y".repeat(1990);
    expect(foldQuestion([{ q: "a", a: "b" }], q)).toBe(q);
  });
  it("honours a custom limit", () => {
    expect(foldQuestion([{ q: "hello there", a: "general kenobi" }], "next", 30)).toBe("next");
  });
});
