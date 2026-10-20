import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PasswordSignInState } from "@/lib/local-auth/signin";

// The demo form after a refused sign-in: each message under the field it is about.
const h = vi.hoisted(() => ({ state: { status: "idle" } as PasswordSignInState }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useActionState: () => [h.state, vi.fn(), false] }));
vi.mock("./actions", () => ({ signInWithPassword: vi.fn() }));

import { DemoSignInForm } from "./demo-form";

// The markup between the Email input and the Password label, and after the Password input.
function render(state: PasswordSignInState) {
  h.state = state;
  const out = renderToStaticMarkup(createElement(DemoSignInForm, {}));
  const emailInput = out.indexOf('id="email"');
  const passwordLabel = out.indexOf('for="password"');
  const passwordInput = out.indexOf('id="password"');
  return { underEmail: out.slice(emailInput, passwordLabel), underPassword: out.slice(passwordInput) };
}

describe("DemoSignInForm errors", () => {
  it("shows an email problem under the Email field, refilling the email", () => {
    const { underEmail, underPassword } = render({ status: "error", message: "Enter a valid email address.", email: "nope", field: "email" });
    expect(underEmail).toContain('value="nope"');
    expect(underEmail).toMatch(/role="alert"[^>]*>Enter a valid email address\.</);
    expect(underPassword).not.toContain("Enter a valid email address.");
  });

  it("shows a password problem (or any other) under the Password field", () => {
    for (const state of [
      { status: "error", message: "Enter a password of 1 to 200 characters.", email: "a@b.co", field: "password" },
      { status: "error", message: "Too many demo sign-ins from your network.", email: "a@b.co" },
    ] as PasswordSignInState[]) {
      const { underEmail, underPassword } = render(state);
      const message = state.status === "error" ? state.message : "";
      expect(underEmail).not.toContain(message);
      expect(underPassword).toContain(message);
    }
  });
});
