import { describe, expect, it } from "vitest";
import type { ConsoleSnapshot, SnapshotApp } from "@/private/console/types";
import { antigravityQuestion, consoleChatPrompt, guard, summaryPrompt, SYSTEM_PROMPT, whyPrompt } from "./prompts";

// R5: the strings no prompt may contain (the same set Task 5's snapshot leak test uses).
const LEAKS = ["@", "://", "postgres", "wp_", "hb_", "sk-", "gsk_", "AIza", "AQ."];
const clean = (s: string) => { for (const l of LEAKS) expect(s, `contains ${l}`).not.toContain(l); };
const text = (m: { content: string }[]) => m.map((x) => x.content).join("\n");

const app: SnapshotApp = {
  id: "orbit-blog", state: "down", uptime30d: 98.456, database: "db-a", lastDeploy: "2026-10-12T19:41:00.000Z",
  problems: [{ kind: "monitor", where: "Monitor /", what: "HTTP 502 for 4 minutes", fix: "Roll back to the previous deployment." }],
};
// A snapshot that slipped something through: the prompt must still be clean.
const dirty: SnapshotApp = {
  ...app,
  database: "postgresql://user:pw@db.example.com:5432/app",
  problems: [{ kind: "monitor", where: "https://web.example.com/api?token=hb_ABCDEFGH123456", what: "owner@example.com saw sk-abcdef123456 and AIzaSyA1B2C3D4E5F6 and gsk_abcdefgh1234 and wp_abcdefghijkl and AQ.Fake0Tstabcdef", fix: "see postgres://x" }],
};

describe("guard", () => {
  it("replaces urls, addresses, key shapes and connection strings", () => {
    clean(guard("mail a@b.co, open https://x.example.com/p?q=1, wp_abcdefghij, AIzaSyABCDEFGH, postgres://u:p@h/db"));
    expect(guard("see https://x.example.com/a")).toBe("see [url]");
  });
  it("collapses whitespace and cuts to the limit", () => {
    expect(guard("a \n\t b")).toBe("a b");
    expect(guard("x".repeat(500)).length).toBe(300);
  });
});

describe("prompts (R5: only scrubbed snapshot data)", () => {
  it("every prompt starts with the fixed system message", () => {
    for (const m of [whyPrompt(app), summaryPrompt([]), consoleChatPrompt({ generatedAt: "t", apps: [], monitors: { up: 0, degraded: 0, down: 0, paused: 0 }, alerts: { open: 0, critical: 0 } }, "q")]) {
      expect(m[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
      expect(m[1].role).toBe("user");
    }
    expect(SYSTEM_PROMPT).toMatch(/only from the data/i);
    expect(SYSTEM_PROMPT).toMatch(/never invent/i);
    expect(SYSTEM_PROMPT).toMatch(/does not cover/i);
  });

  it("whyPrompt carries the app's state, database alias and problems", () => {
    const t = text(whyPrompt(app));
    expect(t).toContain("orbit-blog");
    expect(t).toContain("State: down");
    expect(t).toContain("Database: db-a");
    expect(t).toContain("HTTP 502 for 4 minutes");
    expect(t).toContain("Roll back to the previous deployment.");
    expect(t).toContain("98.46%");
    clean(t);
  });

  it("whyPrompt stays clean even when the snapshot is not", () => {
    clean(text(whyPrompt(dirty)));
  });

  it("summaryPrompt lists title, app and severity only", () => {
    const m = summaryPrompt([{ title: "Next.js 15 reaches end of life", app: "webs-ticketer", severity: "warning" }, { title: "Mail owner@example.com", app: "x", severity: "info" }]);
    expect(m[1].content).toContain("Summarise these 2 recommendations");
    expect(m[1].content).toContain("- [warning] Next.js 15 reaches end of life (app: webs-ticketer)");
    clean(text(m));
  });

  it("consoleChatPrompt embeds the guarded snapshot and the question, nothing else", () => {
    const snap: ConsoleSnapshot = {
      generatedAt: "2026-10-13T01:00:00.000Z", apps: [dirty], monitors: { up: 3, degraded: 1, down: 1, paused: 0 }, alerts: { open: 2, critical: 1 },
      advisor: [{ title: "mail me at a@b.co", app: "x", severity: "info" }],
    };
    const m = consoleChatPrompt(snap, "Which app is down? See https://x.example.com");
    clean(text(m));
    expect(m[1].content).toContain("Which app is down?");
    expect(m[1].content).toContain('"up": 3');
  });
});

describe("antigravityQuestion", () => {
  it("is built from the scrubbed data only", () => {
    const q = antigravityQuestion(app);
    expect(q).toContain('Why is the app "orbit-blog" down');
    expect(q).toContain("HTTP 502 for 4 minutes");
    expect(q).toContain("Roll back to the previous deployment.");
    expect(q).toContain("Database: db-a");
    clean(q);
  });
  it("contains no emails, urls or database names even from a dirty snapshot", () => {
    clean(antigravityQuestion(dirty));
  });
  it("fits the table's 2000-character check", () => {
    const many = { ...app, problems: Array.from({ length: 40 }, (_, i) => ({ kind: "monitor", where: `w${i} ${"x".repeat(100)}`, what: "y".repeat(400), fix: "z".repeat(400) })) };
    expect(antigravityQuestion(many).length).toBeLessThanOrEqual(2000);
  });
});
