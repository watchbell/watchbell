import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ backUpNow: vi.fn(), disconnectDrive: vi.fn(), startDriveConnect: vi.fn() }));

import { buttonClass } from "@/components/kit";
import { DriveStateBlock } from "./drive-card";

const primary = buttonClass({ variant: "primary", size: "sm" });
const secondary = buttonClass({ variant: "secondary", size: "sm" });
// The rendered <button> whose text is `label`, with its class attribute.
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`))?.[1];

describe("DriveStateBlock", () => {
  it("a healthy connection offers Reconnect as a plain button, not a call to action (owner 20 Oct)", () => {
    const html = renderToStaticMarkup(h(DriveStateBlock, { state: { kind: "ok" }, folderName: "Watchpost backups", showDisconnect: true }));
    expect(html).toContain("Connected");
    expect(button(html, "Reconnect")).toBe(secondary);
    expect(html).not.toContain("Reconnect Google Drive");
  });

  it("an expired or removed grant still asks for the reconnect with the primary button", () => {
    const html = renderToStaticMarkup(h(DriveStateBlock, { state: { kind: "reconnect", error: "invalid_grant" }, folderName: "x" }));
    expect(html).toContain("Reconnect needed");
    expect(button(html, "Reconnect Google Drive")).toBe(primary);
  });
});
