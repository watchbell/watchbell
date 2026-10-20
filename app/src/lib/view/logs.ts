import type { LogLine } from "@/lib/data/logs-db";
import { clock } from "@/lib/time";

// A log line as the browser gets it: the time is already WIB text, the message already scrubbed on the server.
export type WireLine = { id: string; time: string; level: string; app: string; text: string };

// clock() gives HH:MM in WIB; seconds are the same in every whole-hour zone, so they come from the ISO string.
export function toWire(l: LogLine): WireLine {
  return {
    id: l.id, time: `${clock(l.at)}${l.at.toISOString().slice(16, 19)}`, level: l.level, app: l.app,
    text: [l.method, l.path, l.status, l.message].filter((x) => x !== null && x !== "").join(" "),
  };
}

// The viewer's level select has Info, Warning and Error: fatal reads as error, debug and trace as info.
export function levelBucket(level: string): "info" | "warning" | "error" {
  if (level === "fatal" || level === "error") return "error";
  if (level === "warning") return "warning";
  return "info";
}

export function filterLines(lines: WireLine[], f: { app: string; level: string; text: string }): WireLine[] {
  const q = f.text.trim().toLowerCase();
  return lines.filter((l) => (!f.app || l.app === f.app) && (!f.level || levelBucket(l.level) === f.level)
    && (!q || `${l.app} ${l.text}`.toLowerCase().includes(q)));
}

export function readText(readAt: number | null, now: number): string {
  if (readAt === null) return "reading…";
  const s = Math.max(0, Math.round((now - readAt) / 1000));
  if (s < 5) return "read just now";
  return s < 60 ? `read ${s}s ago` : `read ${Math.floor(s / 60)} min ago`;
}

// The project's Logs page on vercel.com, from the team slug Sync stored; null when it is missing.
export function vercelLogsUrl(teamSlug: unknown, appName: string): string | null {
  return typeof teamSlug === "string" && teamSlug ? `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(appName)}/logs` : null;
}
