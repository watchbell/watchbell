import type { Extension } from "@/lib/extensions";
import type { PaletteEntry } from "@/lib/extensions";
import { base, insertAfter, mergeExtensions, s7, t2, t3, t4, t5, t6, t7, t9public } from "./registry-blocks";

// The open source edition's registry (exported as registry.ts): the private feature's ONE registration point (R1); the
// core reads it only through @/lib/extensions ("@ext/registry"). The blocks are in registry-blocks.ts.
export { mergeExtensions };

// t7 before t6: t6's advisor-summary calls an AI provider (up to 60 s) inside /api/daily's 60 s budget, so the
// retention steps run first and a slow provider can't starve them. Only T6 carries slots, so "later wins" is unchanged.
// AI › Ask in the palette, right after AI Gateway (where the private edition has its own entry): answers come from the
// providers the user connects.
const ASK: PaletteEntry = { label: "Ask AI", href: "/ai/ask", keywords: ["ask", "question", "answer"] };
const basePublic = { ...base, palette: insertAfter(base.palette ?? [], "/ai", ASK) };

export const registry: Extension = mergeExtensions(basePublic, t2, t3, t4, t5, t7, t9public, t6, s7);
