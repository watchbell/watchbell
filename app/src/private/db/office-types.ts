import type { ActionArea } from "@/private/actions/areas";

// The value sets and row shapes of the Virtual Office's tables (schema.ts: office_events, office_reports, news_items,
// dev_notes). They live here, not in src/private/office, so the schema (and every module that reads it) doesn't import
// the office: the open source edition keeps the tables (its migrations create them) without the office itself. The
// office modules re-export these. Pure.

// office_events.ev (0022, 0024). "wake" (hook, 14 Oct): a message the app injects (a background agent finished, a system
// reminder), not the owner's. "patrol" (14 Oct, 0024): a Patroli result per room (or the Manager's compiled report).
export const OFFICE_EVS = ["prompt", "wake", "tool", "tool_done", "notify", "stop", "sub_start", "sub_stop", "patrol"] as const;
export type OfficeEv = (typeof OFFICE_EVS)[number];

// Token counts the hook reads (read-only) from Claude Code's own transcript on stop / sub_stop: numbers and the model
// name only. in/out/cache* are summed over `calls` model replies; partial = the turn was longer than the hook reads.
export type OfficeUsage = { model: string; in: number; out: number; cacheRead: number; cacheWrite: number; calls: number; partial?: boolean };

// office_reports (0024, 0025, 0040): source, via, the column limits and one room's line of a report.
export const REPORT_SOURCES = ["patrol", "manager", "meeting", "news", "research", "analytics", "content"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];
export const REPORT_VIAS = ["local-claude", "gemini", "claude-code"] as const;
export type ReportVia = (typeof REPORT_VIAS)[number];
export const REPORT_LIMITS = { title: 120, body: 8000, model: 120, via: 40, roomsBytes: 8192, rooms: 12, summary: 200 } as const;
export type ReportRoom = { room: ActionArea; level: "ok" | "warn" | "bad" | "error"; summary: string; model: string | null };

// news_items.topic (0040).
export const NEWS_TOPICS = ["tech", "saham", "emas", "kurs", "politik", "bola"] as const;
export type NewsTopic = (typeof NEWS_TOPICS)[number];

// dev_notes (0032).
export type DevNoteStatus = "queued" | "running" | "done" | "failed" | "skipped";
export type DevTrigger = "manual" | "auto";
