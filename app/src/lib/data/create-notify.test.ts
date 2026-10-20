import { describe, expect, it, vi } from "vitest";
import { createNotice, notifyCreateRequest } from "./create-notify";

// Stage 6 create requests: the Telegram notice is a link to the console, never approval buttons (approval needs aal2).
describe("create request notice", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";
  it("names only the kind and provider, and links to the page with the request", () => {
    const t = createNotice("supabase_project", ID, "https://watch.example.com/");
    expect(t).toContain("Supabase project on Supabase");
    expect(t).toContain(`https://watch.example.com/supabase?create=${ID}`);
    expect(t).toContain("authenticator code");
  });
  it("sends one message without a keyboard; not connected → nothing; a failure never throws", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const record = vi.fn(async () => undefined);
    await notifyCreateRequest({ id: ID, type: "dns_record" }, { target: async () => ({ token: "t", chatId: "c" }), siteUrl: () => "https://w.example.com", lang: async () => "en" as const, send, record });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toHaveLength(3);
    const none = vi.fn();
    await notifyCreateRequest({ id: ID, type: "dns_record" }, { target: async () => null, siteUrl: () => "x", lang: async () => "en" as const, send: none, record });
    expect(none).not.toHaveBeenCalled();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(notifyCreateRequest({ id: ID, type: "dns_record" }, { target: async () => { throw new Error("db"); }, siteUrl: () => "x", lang: async () => "en" as const, send, record })).resolves.toBeUndefined();
  });
});

describe("create request notice language", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";
  it("Indonesian with id, English by default, same link", () => {
    const id = createNotice("supabase_project", ID, "https://w.example.com", "id");
    expect(id).toContain("Permintaan baru: bikin Supabase project di Supabase.");
    expect(id).toContain("Butuh persetujuan Owner (pakai kode authenticator) di console, berlaku 24 jam:");
    expect(id).toContain(`https://w.example.com/supabase?create=${ID}`);
    expect(createNotice("supabase_project", ID, "https://w.example.com", "en")).toContain("New request: create");
  });
  it("notifyCreateRequest sends in the dependency's language", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    await notifyCreateRequest({ id: ID, type: "dns_record" }, { target: async () => ({ token: "t", chatId: "c" }), siteUrl: () => "https://w.example.com", lang: async () => "id" as const, send, record: async () => undefined });
    expect((send.mock.calls[0] as unknown as string[])[2]).toContain("Permintaan baru");
  });
  it("still sends in English when reading the language throws", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    await notifyCreateRequest({ id: ID, type: "dns_record" }, { target: async () => ({ token: "t", chatId: "c" }), siteUrl: () => "https://w.example.com", lang: async () => { throw new Error("db"); }, send, record: async () => undefined });
    expect((send.mock.calls[0] as unknown as string[])[2]).toContain("New request: create");
  });
});
