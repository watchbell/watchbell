import { describe, expect, it, vi } from "vitest";
import { buildStructuredQuery, decodeFields, FS_STRING_CAP, listRootCollections, readRunAnswer, runFirestoreQuery } from "./firestore-query";

const q = (over: Record<string, unknown> = {}) => ({ collection: "orders", where: [], orderBy: null, limit: 20, ...over });

describe("buildStructuredQuery", () => {
  it("builds a plain query with a limit", () => {
    expect(buildStructuredQuery(q())).toMatchObject({ ok: true, body: { structuredQuery: { from: [{ collectionId: "orders" }], limit: 20 } } });
  });

  it("types the values and joins several conditions with AND", () => {
    const r = buildStructuredQuery(q({
      where: [
        { field: "status", op: "==", type: "string", value: "paid" },
        { field: "total", op: ">=", type: "number", value: "10.5" },
        { field: "qty", op: "<", type: "number", value: "3" },
        { field: "archived", op: "!=", type: "boolean", value: "true" },
        { field: "tag", op: "in", type: "string", value: "a, b" },
      ],
      orderBy: { field: "total", dir: "desc" },
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sq = r.body.structuredQuery as { where: { compositeFilter: { op: string; filters: { fieldFilter: { op: string; value: unknown } }[] } }; orderBy: unknown };
    expect(sq.where.compositeFilter.op).toBe("AND");
    expect(sq.where.compositeFilter.filters.map((f) => [f.fieldFilter.op, f.fieldFilter.value])).toEqual([
      ["EQUAL", { stringValue: "paid" }],
      ["GREATER_THAN_OR_EQUAL", { doubleValue: 10.5 }],
      ["LESS_THAN", { integerValue: "3" }],
      ["NOT_EQUAL", { booleanValue: true }],
      ["IN", { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } }],
    ]);
    expect(sq.orderBy).toEqual([{ field: { fieldPath: "total" }, direction: "DESCENDING" }]);
  });

  it("refuses a limit over 100, bad names and bad values", () => {
    expect(buildStructuredQuery(q({ limit: 101 })).ok).toBe(false);
    expect(buildStructuredQuery(q({ limit: 0 })).ok).toBe(false);
    expect(buildStructuredQuery(q({ collection: "a/b" })).ok).toBe(false);
    expect(buildStructuredQuery(q({ collection: "__reserved__" })).ok).toBe(false);
    expect(buildStructuredQuery(q({ where: [{ field: "a b", op: "==", type: "string", value: "x" }] })).ok).toBe(false);
    expect(buildStructuredQuery(q({ where: [{ field: "n", op: "==", type: "number", value: "ten" }] }))).toMatchObject({ ok: false, error: expect.stringContaining("isn't a number") });
    expect(buildStructuredQuery(q({ where: [{ field: "b", op: "==", type: "boolean", value: "yes" }] })).ok).toBe(false);
    expect(buildStructuredQuery(q({ where: [{ field: "t", op: "in", type: "string", value: Array.from({ length: 11 }, (_, i) => i).join(",") }] })).ok).toBe(false);
    expect(buildStructuredQuery(q({ where: Array.from({ length: 6 }, () => ({ field: "a", op: "==", type: "null", value: "" })) })).ok).toBe(false);
    expect(buildStructuredQuery(null).ok).toBe(false);
  });
});

describe("reading documents", () => {
  it("decodes typed values and cuts long ones short", () => {
    const out = decodeFields({
      s: { stringValue: "x".repeat(FS_STRING_CAP + 5) }, i: { integerValue: "42" }, big: { integerValue: "9007199254740993" }, d: { doubleValue: 1.5 },
      b: { booleanValue: true }, n: { nullValue: null }, t: { timestampValue: "2026-10-16T00:00:00Z" },
      r: { referenceValue: "projects/p/databases/(default)/documents/users/u1" },
      a: { arrayValue: { values: Array.from({ length: 25 }, (_, k) => ({ integerValue: String(k) })) } },
      m: { mapValue: { fields: { inner: { stringValue: "y" } } } },
    });
    expect(String(out.s)).toContain(`(${FS_STRING_CAP + 5} chars)`);
    expect(out).toMatchObject({ i: 42, big: "9007199254740993", d: 1.5, b: true, n: null, t: "2026-10-16T00:00:00Z", r: "users/u1", m: { inner: "y" } });
    expect((out.a as unknown[]).length).toBe(21);
    expect((out.a as unknown[]).at(-1)).toBe("… 5 more");
  });

  it("counts reads: one per document, at least one per query", () => {
    const docs = [{ document: { name: "projects/p/databases/(default)/documents/orders/o1", fields: { x: { integerValue: "1" } } } }, { readTime: "t" }];
    expect(readRunAnswer(docs)).toEqual({ docs: [{ id: "o1", json: '{\n "x": 1\n}' }], reads: 1, truncated: false });
    expect(readRunAnswer([{ readTime: "t" }])).toEqual({ docs: [], reads: 1, truncated: false });
    expect(readRunAnswer({ nope: 1 })).toBeNull();
  });
});

describe("REST calls", () => {
  it("lists root collections with POST :listCollectionIds", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ collectionIds: ["users", "orders"], nextPageToken: "n" }), { status: 200 }));
    expect(await listRootCollections("tok", "proj-1", { fetch: f as unknown as typeof fetch })).toEqual({ ok: true, data: { ids: ["orders", "users"], more: true } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://firestore.googleapis.com/v1/projects/proj-1/databases/(default)/documents:listCollectionIds");
    expect(init.method).toBe("POST");
  });

  it("runs a query with POST :runQuery and passes Google's refusal through", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } }), { status: 403 }));
    const r = await runFirestoreQuery("tok", "proj-1", { structuredQuery: {} }, { fetch: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, kind: "scope", reason: "PERMISSION_DENIED" });
    expect((f.mock.calls[0] as unknown as [string])[0]).toMatch(/documents:runQuery$/);
  });
});
