import { describe, expect, it } from "vitest";
import { opById } from "@/private/openapi/operations";
import { applyExample, initialBuilder } from "./request";
import { deleteExample, exampleFrom, forOp, MAX_EXAMPLES, parseExamples, renameExample, type SavedExample, saveExample } from "./examples";

const now = new Date("2026-10-13T00:00:00Z");
const ex = (id: string, opId = "status", name = id): SavedExample => ({ id, opId, name, path: {}, query: {}, headers: {}, body: "", savedAt: now.toISOString() });

describe("exampleFrom", () => {
  it("keeps typed path, query and body, and drops Authorization and Cookie rows", () => {
    const op = opById("mcp")!;
    const b = { ...initialBuilder(op), headers: [{ name: "Accept", value: "application/json" }, { name: "Authorization", value: "Bearer abc" }, { name: "cookie", value: "a=b" }, { name: "X-Client", value: "" }] };
    const r = exampleFrom(op, b, "  tools list ", "id1", now);
    expect(r).toEqual({ ok: true, example: { id: "id1", opId: "mcp", name: "tools list", path: {}, query: {}, headers: { Accept: "application/json" }, body: op.body, savedAt: now.toISOString() } });
  });
  it("never keeps a heartbeat token path value", () => {
    const op = opById("ping")!;
    const r = exampleFrom(op, { ...initialBuilder(op), path: { token: "hb_" + "0".repeat(32) } }, "my job", "i", now);
    expect(r.ok && r.example.path).toEqual({});
  });
  it("keeps a non-secret path value and a filled query value", () => {
    const op = opById("status-app")!;
    expect(exampleFrom(op, { ...initialBuilder(op), path: { app: "orbit-blog" } }, "n", "i", now)).toMatchObject({ ok: true, example: { path: { app: "orbit-blog" } } });
    const s = opById("status")!;
    expect(exampleFrom(s, { ...initialBuilder(s), query: [{ name: "include", value: "alerts" }, { name: "x", value: " " }] }, "n", "i", now)).toMatchObject({ ok: true, example: { query: { include: "alerts" } } });
  });
  it("refuses a body, query or header that carries a key or token", () => {
    const op = opById("ai-chat")!;
    const key = "wp_" + "A".repeat(40);
    const secretBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: `my key is ${key}` }] });
    expect(exampleFrom(op, { ...initialBuilder(op), body: secretBody }, "n", "i", now)).toEqual({ ok: false, error: "That looks like a key or token. Remove it before saving; examples never keep secrets." });
    expect(exampleFrom(op, { ...initialBuilder(op), headers: [{ name: "X-Note", value: key }] }, "n", "i", now).ok).toBe(false);
    expect(exampleFrom(op, { ...initialBuilder(op), query: [{ name: "k", value: "hb_" + "f".repeat(32) }] }, "n", "i", now).ok).toBe(false);
    expect(exampleFrom(op, { ...initialBuilder(op), headers: [{ name: "X-Note", value: "wb_" + "A".repeat(40) }] }, "n", "i", now).ok).toBe(false);
  });
  it("needs a name of 1 to 60 characters", () => {
    const op = opById("me")!;
    expect(exampleFrom(op, initialBuilder(op), "  ", "i", now)).toEqual({ ok: false, error: "Give the example a name." });
    expect(exampleFrom(op, initialBuilder(op), "x".repeat(61), "i", now).ok).toBe(false);
  });
  it("round-trips through applyExample", () => {
    const op = opById("status")!;
    const saved = exampleFrom(op, { ...initialBuilder(op), query: [{ name: "include", value: "alerts" }] }, "only alerts", "i", now);
    expect(saved.ok && applyExample(op, saved.example).query).toEqual([{ name: "include", value: "alerts" }]);
  });
});

describe("saveExample / renameExample / deleteExample", () => {
  it("adds, and replaces an example with the same name for the same endpoint (case-insensitive)", () => {
    const a = saveExample([], ex("1", "status", "Alerts"));
    expect(a.ok && a.list.map((e) => e.id)).toEqual(["1"]);
    const b = a.ok ? saveExample(a.list, { ...ex("2", "status", "alerts"), body: "x" }) : null;
    expect(b?.ok && b.list).toHaveLength(1);
    expect(b?.ok && b.list[0]).toMatchObject({ id: "1", name: "alerts", body: "x" });
    const c = b?.ok ? saveExample(b.list, ex("3", "me", "alerts")) : null;
    expect(c?.ok && c.list).toHaveLength(2);
  });
  it("stops at 100 examples but still lets a same-name save replace", () => {
    const full = Array.from({ length: MAX_EXAMPLES }, (_, i) => ex(String(i), "status", `n${i}`));
    expect(saveExample(full, ex("x", "status", "new"))).toEqual({ ok: false, error: "You can keep 100 examples. Delete one first." });
    expect(saveExample(full, ex("x", "status", "N5")).ok).toBe(true);
  });
  it("renames to a free name only", () => {
    const list = [ex("1", "status", "a"), ex("2", "status", "b"), ex("3", "me", "c")];
    expect(renameExample(list, "1", " z ")).toMatchObject({ ok: true });
    expect(renameExample(list, "1", "B")).toEqual({ ok: false, error: "This endpoint already has an example with that name." });
    expect(renameExample(list, "1", "c").ok).toBe(true);
    expect(renameExample(list, "9", "q")).toEqual({ ok: false, error: "That example is gone." });
    expect(renameExample(list, "1", "").ok).toBe(false);
  });
  it("deletes by id and lists per endpoint", () => {
    const list = [ex("1", "status"), ex("2", "me")];
    expect(deleteExample(list, "1").map((e) => e.id)).toEqual(["2"]);
    expect(forOp(list, "me").map((e) => e.id)).toEqual(["2"]);
  });
});

describe("parseExamples", () => {
  it("reads what was saved and drops anything else", () => {
    const good = ex("1");
    const raw = JSON.stringify([good, { id: 5 }, "x", { ...good, id: "2", path: { a: 1 } }, { ...good, id: "3", name: "" }]);
    expect(parseExamples(raw)).toEqual([good]);
  });
  it("is empty for missing or broken storage", () => {
    for (const raw of [null, "", "{", "{}", "null", "5"]) expect(parseExamples(raw)).toEqual([]);
  });
  it("drops a stored example that carries a key (hand-edited storage)", () => {
    expect(parseExamples(JSON.stringify([{ ...ex("1"), body: "wp_" + "A".repeat(40) }]))).toEqual([]);
  });
  it("keeps at most 100", () => {
    expect(parseExamples(JSON.stringify(Array.from({ length: 150 }, (_, i) => ex(String(i), "status", `n${i}`))))).toHaveLength(MAX_EXAMPLES);
  });
});
