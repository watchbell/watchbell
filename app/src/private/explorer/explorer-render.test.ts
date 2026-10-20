import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OPS, opById } from "@/private/openapi/operations";
import { EndpointList } from "./endpoint-list";
import { Explorer } from "./explorer";
import type { ExplorerModels } from "./live-model";

// The first (server) render of every endpoint: nothing throws without a browser, the right fields are there, and no
// secret is in the markup. Behaviour (Send, saved examples) is covered by the pure modules' tests.
const origin = "https://watch.example.com";
const render = (id: string) => renderToStaticMarkup(h(Explorer, { opId: id, origin }));

describe("Explorer first render", () => {
  it("renders every endpoint", () => {
    for (const o of OPS) {
      const out = render(o.id);
      expect(out, o.id).toContain(o.path);
      expect(out, o.id).toContain("Snippets");
      expect(out, o.id).toContain(o.scopeLabel);
    }
  });
  it("offers the key field only where a key is needed, and keeps it a password field with nothing in it", () => {
    for (const id of ["status", "ai-chat", "me", "advice", "mcp", "openapi"]) {
      const out = render(id);
      expect(out, id).toContain('id="api-key"');
      expect(out, id).toMatch(/id="api-key" type="password"[^>]*value=""/);
      expect(out, id).toContain("Never saved");
    }
    for (const id of ["health", "ping", "collect"]) expect(render(id), id).not.toContain('id="api-key"');
  });
  it("shows the request builder with the endpoint's parameters, headers and JSON body", () => {
    const chat = render("ai-chat");
    expect(chat).toContain("JSON body");
    expect(chat).toContain("api-explorer");
    expect(chat).toContain("Send");
    expect(chat).toContain("Save as example");
    expect(chat).toContain("Reset");
    expect(render("status")).toContain("include");
    expect(render("status-app")).toContain("path");
    expect(render("advice")).toContain("required");
    expect(render("mcp")).toContain("MCP-Protocol-Version");
  });
  it("lists the spec's examples and the three snippet languages", () => {
    const out = render("ai-chat");
    expect(out).toContain("Streaming (SSE)");
    expect(out).toContain("from the spec");
    expect(out).toContain(">curl<");
    expect(out).toContain(">PowerShell<");
    expect(out).toContain(">JavaScript (fetch)<");
    expect(out).toContain("curl -X POST");
  });
  it("takes a heartbeat token as a hidden path field and never prints one", () => {
    const out = render("ping");
    expect(out).toMatch(/aria-label="token \(path\)"[^>]*type="password"|type="password"[^>]*aria-label="token \(path\)"/);
    expect(out).toContain("HEARTBEAT_TOKEN");
    expect(out).not.toMatch(/hb_[0-9a-f]{32}[^"]*"?\s*value/);
  });
  it("shows docs-only endpoints without Try it", () => {
    for (const id of ["collect", "watchdog", "daily"]) {
      const out = render(id);
      expect(out, id).toContain("Docs only");
      expect(out, id).not.toContain("Save as example");
      expect(out, id).not.toContain(">Send<");
      expect(out, id).toContain("Example response");
    }
  });
  it("renders nothing for an unknown endpoint", () => {
    expect(render("nope")).toBe("");
  });
});

describe("Explorer with the owner's live models", () => {
  const models: ExplorerModels = {
    defaultModel: "test/combo-new",
    options: [
      { id: "test/combo-new", isDefault: true, async: false },
      { id: "test/prrojects", isDefault: false, async: false },
      { id: "ag/gemini-3.8-flash-high", isDefault: false, async: true },
    ],
  };
  const live = (id: string, m: ExplorerModels = models) => renderToStaticMarkup(h(Explorer, { opId: id, origin, models: m }));
  it("pre-fills the body and the snippets with the live default model, never the generic one", () => {
    const out = live("ai-chat");
    expect(out).toContain("test/combo-new");
    const textarea = out.match(/<textarea[^>]*id="api-body"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
    expect(textarea).toContain("test/combo-new");
    expect(textarea).not.toContain("gemini/gemini-3.8-flash");
    expect(out).toContain("&quot;model&quot;:&quot;test/combo-new&quot;"); // the curl snippet
  });
  it("offers a Model list above the body: default first and marked, no ag/ model on chat completions", () => {
    const out = live("ai-chat");
    expect(out).toContain('id="api-model"');
    const opts = [...out.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
    expect(opts[0]).toEqual(["test/combo-new", "test/combo-new (default)"]);
    expect(opts.map((o) => o[0])).toContain("test/prrojects");
    expect(opts.map((o) => o[0])).not.toContain("ag/gemini-3.8-flash-high");
    expect(out.indexOf('id="api-model"')).toBeLessThan(out.indexOf('id="api-body"'));
  });
  it("shows the empty state with a link to Models when no model is on", () => {
    const out = live("ai-chat", { defaultModel: null, options: [] });
    expect(out).toContain("No model is on — switch one on under");
    expect(out).toContain('href="/ai/models"');
    expect(out).not.toContain('id="api-model"');
  });
  it("has no Model list where the body has no model", () => {
    for (const id of ["ai-questions", "mcp", "status"]) expect(live(id), id).not.toContain('id="api-model"');
  });
});

describe("EndpointList", () => {
  const out = renderToStaticMarkup(h(EndpointList, { activeId: "status" }));
  it("groups every endpoint by tag with a method chip, links to /api-docs/<id> and marks the active one", () => {
    for (const tag of ["AI", "Console", "MCP", "Health", "Heartbeats", "Scheduler"]) expect(out).toContain(`>${tag}<`);
    for (const o of OPS) expect(out).toContain(`href="/api-docs/${o.id}"`);
    expect(out).toMatch(/href="\/api-docs\/status"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/api-docs\/status"/);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toContain(">POST<");
    expect(out).toContain(">GET<");
  });
  it("puts a lock only on the docs-only endpoints", () => {
    expect(out.match(/aria-label="Docs only"/g)).toHaveLength(OPS.filter((o) => o.docsOnly).length);
  });
  it("shows /api/v1 paths without the prefix and the others whole", () => {
    expect(out).toContain(">/status<");
    expect(out).toContain(">/api/health<");
    expect(opById("health")?.path).toBe("/api/health");
  });
});
