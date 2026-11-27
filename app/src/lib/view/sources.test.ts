import { describe, expect, it } from "vitest";
import { alertmanagerYml, ingestUrl, maskedUrl, sourceState, WIZARD_POLL_MAX_MS, WIZARD_POLL_MS } from "./sources";

const now = new Date("2026-11-25T10:00:00Z");
const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
const src = (o: Partial<{ enabled: boolean; createdAt: Date; lastSeenAt: Date | null }> = {}) => ({ enabled: true, createdAt: days(30), lastSeenAt: days(1), ...o });

describe("sourceState", () => {
  it("none, active, quiet after 7 days without an alert, revoked", () => {
    expect(sourceState(null, now)).toBe("none");
    expect(sourceState(src(), now)).toBe("active");
    expect(sourceState(src({ lastSeenAt: days(8) }), now)).toBe("quiet");
    expect(sourceState(src({ lastSeenAt: null, createdAt: days(2) }), now)).toBe("active");
    expect(sourceState(src({ lastSeenAt: null, createdAt: days(9) }), now)).toBe("quiet");
    expect(sourceState(src({ enabled: false }), now)).toBe("revoked");
  });
});

describe("URLs and the alertmanager.yml snippet", () => {
  const T = "am_8f2kQwErTyUiPaSdFgHjKz";
  it("builds the webhook URL from the site's origin, and a masked one from the prefix", () => {
    expect(ingestUrl("https://ops.kopisenja.example/", T)).toBe(`https://ops.kopisenja.example/api/alertmanager/${T}`);
    expect(maskedUrl("https://ops.kopisenja.example", "am_8f2k")).toBe("https://ops.kopisenja.example/api/alertmanager/am_8f2k…");
  });

  it("fills the receiver and route in, with send_resolved and at most 100 alerts a message", () => {
    // Final review M7/M8: a child route with continue: true, never the top-level receiver, so pasting it can't take the
    // user's other receivers off their alerts; repeat_interval under 24 h so a still-firing alert never goes stale.
    expect(alertmanagerYml("https://x.example/api/alertmanager/am_1")).toBe([
      "# 1. Under receivers:",
      "receivers:",
      "  - name: watchbell",
      "    webhook_configs:",
      "      - url: https://x.example/api/alertmanager/am_1",
      "        send_resolved: true",
      "        max_alerts: 100",
      "",
      "# 2. As the first entry of your route's routes: (your own receiver and routes stay as they are)",
      "route:",
      "  routes:",
      "    - receiver: watchbell",
      "      continue: true",
      "      repeat_interval: 4h",
    ].join("\n"));
  });

  it("polls every 5 seconds for at most 2 minutes", () => {
    expect([WIZARD_POLL_MS, WIZARD_POLL_MAX_MS]).toEqual([5_000, 120_000]);
  });
});
