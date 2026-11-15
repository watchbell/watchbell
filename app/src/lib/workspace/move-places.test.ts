import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Watchbell 1.8 (spec §5, Moving; final review I1): every page that lists a top-level resource can move it, or a
// workspace would show "nothing watched" for things it can never receive (Cloudflare zones on DNS records).
describe("Move to workspace is offered wherever top-level things are listed", () => {
  it.each(["apps", "uptime", "domains", "dns", "supabase", "neon", "firebase", "turso", "upstash", "d1", "repos"])("%s", (page) => {
    const src = readFileSync(join(process.cwd(), "src", "app", "(console)", page, "page.tsx"), "utf8");
    expect(src).toContain("<MoveToWorkspace");
  });
});
