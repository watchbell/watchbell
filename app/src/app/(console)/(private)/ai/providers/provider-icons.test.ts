import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESETS } from "@/private/ai/providers/presets";
import { PROVIDER_ICONS } from "./provider-icons";

describe("PROVIDER_ICONS", () => {
  it("has an icon for every preset kind", () => {
    for (const kind of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) expect(PROVIDER_ICONS[kind]).toBeTruthy();
  });

  // A plain value exported from a "use client" file reaches a server component as undefined (13 Oct: the Providers
  // page crashed with "Element type is invalid"), so the map must live in a module without the directive.
  it("lives outside any \"use client\" module", () => {
    expect(readFileSync(join(__dirname, "provider-icons.ts"), "utf8")).not.toMatch(/^\s*["']use client["']/);
  });
});
