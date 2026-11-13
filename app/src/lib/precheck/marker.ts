import { z } from "zod";
import { MARKER, type Marker } from "./report";

// Watchbell 1.4: the console reads the pre-deploy check's marker back from a pull request comment (./report.ts writes
// it). Anything that isn't exactly a marker is null. Pure.

const n = z.number().int().min(0);
const markerSchema = z.object({
  v: z.literal(1), sha: z.string().regex(/^[0-9a-f]{7,40}$/), verdict: z.enum(["fix", "check", "ok"]), at: z.string().max(40),
  counts: z.object({ critical: n, high: n, moderate: n, low: n, secrets: n, env: n }),
});

export function parseMarker(body: string): Marker | null {
  const text = body.trimStart();
  if (!text.startsWith(MARKER)) return null;
  const end = text.indexOf(" -->");
  if (end < 0 || end > 2000) return null;
  try {
    const p = markerSchema.safeParse(JSON.parse(text.slice(MARKER.length, end)));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}
