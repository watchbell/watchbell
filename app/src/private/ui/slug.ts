// The id prefix of a provider's models ("gemini/gemini-3.8-flash"). A mirror of providerSlug() in
// src/private/ai/providers/presets.ts (Task 3), kept here so the page reads need no server module; slug.test.ts pins the same cases.
export function providerSlug(kind: string, name: string): string {
  if (kind !== "custom") return kind;
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";
}
