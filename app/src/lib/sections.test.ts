import { describe, expect, it } from "vitest";
import { RULE_KEYS } from "@/lib/alerts/catalog";
import { PROVIDERS } from "@/lib/providers/info";
import {
  alertPaused, alertSection, cleanSectionsOff, pausedAlertKeys, pausedSections, RULE_SECTION, SECTION_IDS, SECTION_OF_PROVIDER, SECTIONS, sectionsAvailable, sectionsOn, SWITCHABLE,
} from "./sections";

describe("sections (Watchbell 1.2, D11)", () => {
  it("has the five sections in menu order; Home and Manage can't be switched", () => {
    expect([...SECTION_IDS]).toEqual(["home", "hosting", "database", "devops", "manage"]);
    expect(SWITCHABLE).toEqual(["hosting", "database", "devops"]);
    for (const id of SECTION_IDS) expect(SECTIONS[id].holds.length).toBeGreaterThan(10);
  });

  it("maps every provider to its section, exactly as the plan says", () => {
    expect(SECTION_OF_PROVIDER).toEqual({
      vercel: "hosting", cloudflare: "hosting", supabase: "database", neon: "database", firebase: "database", turso: "database", upstash: "database", github: "devops", github_write: "devops",
    });
    expect(Object.keys(SECTION_OF_PROVIDER).sort()).toEqual([...PROVIDERS].sort());
  });

  // Owner ruling (review A1, Important 1): uptime checks and heartbeats need no provider, so Hosting is there from the start.
  it("shows Home, Hosting and Manage on a fresh install, so Uptime is reachable", () => {
    expect([...sectionsOn([], [])]).toEqual(["home", "hosting", "manage"]);
    expect([...sectionsAvailable([])]).toEqual(["home", "hosting", "manage"]);
  });

  it("turns Database and DevOps on when a provider of theirs is connected", () => {
    expect([...sectionsOn(["vercel"], [])]).toEqual(["home", "hosting", "manage"]);
    expect([...sectionsOn(["cloudflare"], [])]).toEqual(["home", "hosting", "manage"]);
    expect([...sectionsOn(["neon"], [])]).toEqual(["home", "hosting", "database", "manage"]);
    expect([...sectionsOn(["github_write"], [])]).toEqual(["home", "hosting", "devops", "manage"]);
  });

  it("keeps Database for existing databases without their provider", () => {
    expect([...sectionsOn([], [], { databases: true })]).toEqual(["home", "hosting", "database", "manage"]);
  });

  it("shows every section that has data on an install from before 1.2 (nothing disappears)", () => {
    expect([...sectionsOn(["vercel", "supabase", "neon", "cloudflare", "github"], [], { databases: true })]).toEqual([...SECTION_IDS]);
  });

  it("hides a section turned off by hand, never Home or Manage", () => {
    const all = ["vercel", "supabase", "github"] as const;
    expect([...sectionsOn(all, ["hosting"])]).toEqual(["home", "database", "devops", "manage"]);
    expect([...sectionsOn(all, ["home", "manage", "devops"])]).toEqual(["home", "hosting", "database", "manage"]);
    expect([...sectionsOn([], ["hosting"])]).toEqual(["home", "manage"]);
  });

  it("reads the stored switch leniently: switchable ids only, once each, in menu order", () => {
    expect(cleanSectionsOff(["devops", "hosting", "devops", "home", "manage", "cloud", 3])).toEqual(["hosting", "devops"]);
    expect(cleanSectionsOff(null)).toEqual([]);
    expect(cleanSectionsOff({ off: ["hosting"] })).toEqual([]);
    expect([...pausedSections(["database", "manage"])]).toEqual(["database"]);
  });

  it("gives every alert rule a section (the collector's own health is never paused)", () => {
    for (const k of RULE_KEYS) expect(k in RULE_SECTION).toBe(true);
    expect(alertSection("MonitorDown")).toBe("hosting");
    expect(alertSection("CertExpiringSoon")).toBe("hosting");
    expect(alertSection("StorageAlmostFull")).toBe("database");
    expect(alertSection("VulnerableDependency")).toBe("devops");
    // Watchbell 1.2: the Next.js check needs no GitHub (its update PR does, and pauses with DevOps in the proposals step).
    expect(alertSection("FrameworkVulnerable")).toBe("hosting");
    expect(alertPaused(new Set(["devops"] as const), "FrameworkVulnerable")).toBe(false);
    expect(alertSection("CollectorStale")).toBeNull();
    expect(alertSection("CredentialExpiring", "neon")).toBe("database");
    expect(alertSection("CredentialExpiring", "drive")).toBeNull();
    expect(alertSection("CredentialExpiring")).toBeNull();
    expect(alertSection("LogErrorSpike")).toBe("hosting");
    expect(alertSection("Unknown")).toBeNull();
  });

  it("pauses the alerts of a paused section only", () => {
    const paused = new Set(["database"] as const);
    expect(alertPaused(paused, "DatabasePaused")).toBe(true);
    expect(alertPaused(paused, "CredentialExpiring", "supabase")).toBe(true);
    expect(alertPaused(paused, "CredentialExpiring", "vercel")).toBe(false);
    expect(alertPaused(paused, "MonitorDown")).toBe(false);
    expect(alertPaused(paused, "CollectorStale")).toBe(false);
    expect(alertPaused(new Set(), "DatabasePaused")).toBe(false);
    expect(pausedAlertKeys(new Set(["devops"] as const))).toEqual({ ruleKeys: ["VulnerableDependency"], providers: ["github", "github_write"] });
  });
});
