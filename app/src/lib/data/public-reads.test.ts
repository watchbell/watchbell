import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 1.8.1 (public routes audit, owner's security question of 15 Nov): pages anyone can open without signing in must not
// read the database once per request, or a flood fills the pooler's 15 slots and the console stalls. The sign-in page,
// the logo and the public status page read the brand and the slugs through per-instance memos (lib/memo.ts).
const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
const PUBLIC = ["app/signin/page.tsx", "app/brand-icon/route.ts", "app/s/[slug]/page.tsx", "app/s/[slug]/badge/[file]/route.ts"];

describe("public routes read through memos", () => {
  it.each(PUBLIC)("%s never calls readBrand() or readBrandLogo() directly", (p) => {
    expect(src(p)).not.toMatch(/\breadBrand(Logo)?\(\)/);
  });

  it.each(["app/s/[slug]/page.tsx", "app/s/[slug]/badge/[file]/route.ts"])("%s checks the slug against the published list first", (p) => {
    expect(src(p)).toMatch(/isPublishedSlug\(/);
  });

  it("the logo's 404 is cached briefly at the CDN instead of reaching the function every time", () => {
    expect(src("app/brand-icon/route.ts")).not.toMatch(/"No logo\."[^)]*no-store/);
  });
});
