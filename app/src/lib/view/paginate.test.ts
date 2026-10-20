import { describe, expect, it } from "vitest";
import { heldAnchor, PAGE_SIZE, paginate, paginateHeld, rangeText } from "./paginate";

const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("paginate", () => {
  it("uses 25 rows a page", () => {
    expect(PAGE_SIZE).toBe(25);
  });
  it("handles no rows: one empty page", () => {
    expect(paginate([], 1, 25)).toEqual({ rows: [], page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });
  it("keeps everything on one page when it fits", () => {
    const p = paginate(nums(25), 1, 25);
    expect(p).toMatchObject({ page: 1, pages: 1, from: 1, to: 25, total: 25 });
    expect(p.rows).toHaveLength(25);
  });
  it("splits an exact multiple without a trailing empty page", () => {
    const p = paginate(nums(50), 2, 25);
    expect(p).toMatchObject({ page: 2, pages: 2, from: 26, to: 50, total: 50 });
    expect(p.rows[0]).toBe(26);
    expect(p.rows.at(-1)).toBe(50);
  });
  it("returns the first page", () => {
    const p = paginate(nums(104), 1, 25);
    expect(p).toMatchObject({ page: 1, pages: 5, from: 1, to: 25, total: 104 });
    expect(p.rows).toEqual(nums(25));
  });
  it("returns the last, partial page", () => {
    const p = paginate(nums(104), 5, 25);
    expect(p).toMatchObject({ page: 5, pages: 5, from: 101, to: 104, total: 104 });
    expect(p.rows).toEqual([101, 102, 103, 104]);
  });
  it("clamps a page past the end after the rows shrink", () => {
    const p = paginate(nums(30), 5, 25);
    expect(p).toMatchObject({ page: 2, pages: 2, from: 26, to: 30 });
    expect(p.rows).toEqual([26, 27, 28, 29, 30]);
  });
  it("clamps to page 1 when the rows shrink to one page or none", () => {
    expect(paginate(nums(10), 3, 25)).toMatchObject({ page: 1, pages: 1, from: 1, to: 10 });
    expect(paginate([], 3, 25)).toMatchObject({ page: 1, from: 0, to: 0 });
  });
  it("clamps a page below 1 or a fractional page", () => {
    expect(paginate(nums(60), 0, 25).page).toBe(1);
    expect(paginate(nums(60), -4, 25).page).toBe(1);
    expect(paginate(nums(60), 2.7, 25).page).toBe(2);
    expect(paginate(nums(60), Number.NaN, 25).page).toBe(1);
  });
  it("does not mutate its input", () => {
    const rows = nums(60);
    paginate(rows, 2, 25);
    expect(rows).toEqual(nums(60));
  });
});

describe("rangeText", () => {
  it("reads 1–25 of 104 with an en dash", () => {
    expect(rangeText(paginate(nums(104), 1, 25))).toBe("1–25 of 104");
    expect(rangeText(paginate(nums(104), 5, 25))).toBe("101–104 of 104");
  });
  it("can shift the numbers for a feed that kept its place while new rows arrived", () => {
    expect(rangeText(paginate(nums(104), 2, 25), 3, 107)).toBe("29–53 of 107");
  });
});

describe("paginateHeld (a newest-first feed that keeps its place)", () => {
  const ev = (ids: number[]) => ids.map((id) => ({ id: String(id) }));
  // Newest first: ids 104..1. The reader left page 1 when id 104 was the head.
  const old = ev(Array.from({ length: 104 }, (_, i) => 104 - i));
  const anchor = "104"; // the head of the list when the reader left page 1

  it("with no anchor it is plain paging", () => {
    const p = paginateHeld(old, 2, null, 25);
    expect(p).toMatchObject({ page: 2, pages: 5, from: 26, to: 50, total: 104, shift: 0 });
    expect(p.rows[0].id).toBe("79");
  });
  it("keeps the same rows on screen while new rows arrive on top, and the numbers count them", () => {
    const before = paginateHeld(old, 2, anchor, 25);
    const grown = [...ev([107, 106, 105]), ...old];
    const after = paginateHeld(grown, 2, anchor, 25);
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
    expect(after).toMatchObject({ shift: 3, from: 26, to: 50, total: 104 });
    expect(rangeText(after, after.shift, grown.length)).toBe("29–53 of 107");
  });
  it("next and previous keep stepping from the held position", () => {
    const grown = [...ev([107, 106, 105]), ...old];
    expect(paginateHeld(grown, 3, anchor, 25).rows[0].id).toBe("54");
    expect(paginateHeld(grown, 1, anchor, 25).shift).toBe(0);
  });
  it("an anchor that is no longer in the list holds nothing", () => {
    expect(paginateHeld(old, 2, "999", 25).shift).toBe(0);
  });
  it("when the held list shrinks to one page it falls back to the true first page", () => {
    const small = [...ev([9, 8, 7]), ...ev([6, 5, 4, 3, 2, 1])];
    const p = paginateHeld(small, 2, "6", 25);
    expect(p).toMatchObject({ page: 1, shift: 0, from: 1, to: 9 });
    expect(p.rows).toHaveLength(9);
  });
});

describe("heldAnchor (which row to hold when the reader changes page)", () => {
  const rows = [{ id: "9" }, { id: "8" }, { id: "7" }];
  it("leaving page 1 holds the current head", () => {
    expect(heldAnchor(rows, 0, null, 2)).toBe("9");
  });
  it("going back to page 1 holds nothing", () => {
    expect(heldAnchor(rows, 3, "7", 1)).toBeNull();
  });
  it("keeps the old anchor while it still shifts the list", () => {
    expect(heldAnchor(rows, 2, "7", 3)).toBe("7");
  });
  it("takes a fresh head when the held view fell back to the true first page, so Next is never dead", () => {
    // 'shift' is 0 although an anchor is stored: paginateHeld fell back to page 1.
    expect(heldAnchor(rows, 0, "7", 2)).toBe("9");
    const long = Array.from({ length: 60 }, (_, i) => ({ id: String(60 - i) }));
    const fellBack = paginateHeld(long.slice(0, 30), 2, "5", 25); // anchor not in the (shrunk) list
    expect(fellBack.shift).toBe(0);
    const anchor = heldAnchor(long.slice(0, 30), fellBack.shift, "5", 2);
    expect(paginateHeld(long.slice(0, 30), 2, anchor, 25).page).toBe(2);
  });
  it("has no head to hold in an empty list", () => {
    expect(heldAnchor([], 0, null, 2)).toBeNull();
  });
});
