import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ signInWithPassword: vi.fn(), sendSignInLink: vi.fn() }));

import { PasswordSignInForm } from "./password-form";
import { SignInForm } from "./signin-form";

// Watchbell 1.7 (spec §7): the sign-in page names the brand; without one it still says Watchbell.
describe("sign-in forms with a brand", () => {
  it("say Sign in to <app name>", () => {
    expect(renderToStaticMarkup(h(PasswordSignInForm, { appName: "Studio Nusa Monitoring" }))).toContain("Sign in to Studio Nusa Monitoring");
    expect(renderToStaticMarkup(h(SignInForm, { siteKey: "", appName: "Studio Nusa Monitoring" }))).toContain("Sign in to Studio Nusa Monitoring");
    expect(renderToStaticMarkup(h(PasswordSignInForm, {}))).toContain("Sign in to Watchbell");
  });
});
