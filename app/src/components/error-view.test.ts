import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

import ConsoleError from "@/app/(console)/error";
import RootError from "@/app/error";
import { DEMO_BUSY, DEMO_TOO_MANY, demoNoticeError } from "@/lib/demo/notices";
import { ErrorView } from "./error-view";

const DEFAULT_TEXT = "Watchbell couldn't read its database, or a setting is missing.";
const err = (digest: string) => Object.assign(new Error("hidden in production"), { digest });

describe("the error screens", () => {
  it("show the usual text and the reference for an ordinary error", () => {
    const out = renderToStaticMarkup(h(ErrorView, { digest: "1234567", retry: () => undefined }));
    expect(out).toContain("This page didn&#x27;t load");
    expect(out).toContain(DEFAULT_TEXT.replace("'", "&#x27;"));
    expect(out).toContain("Reference 1234567");
    for (const Boundary of [ConsoleError, RootError]) {
      const page = renderToStaticMarkup(h(Boundary, { error: err("1234567"), retry: () => undefined }));
      expect(page).toContain("Reference 1234567");
      expect(page).not.toContain(DEMO_BUSY);
    }
  });

  it("show the demo's busy and too-many notices as themselves, from their digest alone", () => {
    for (const notice of [DEMO_BUSY, DEMO_TOO_MANY] as const) {
      const { digest } = demoNoticeError(notice);
      for (const Boundary of [ConsoleError, RootError]) {
        const page = renderToStaticMarkup(h(Boundary, { error: err(digest), retry: () => undefined }));
        expect(page).toContain(notice);
        expect(page).not.toContain("Reference");
        expect(page).not.toContain(DEFAULT_TEXT.slice(0, 20));
      }
    }
  });
});
