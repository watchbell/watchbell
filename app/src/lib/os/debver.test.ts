import { describe, expect, it } from "vitest";
import { compareDeb } from "./debver";

const lt = (a: string, b: string) => expect(compareDeb(a, b), `${a} < ${b}`).toBeLessThan(0);
const eq = (a: string, b: string) => expect(compareDeb(a, b), `${a} = ${b}`).toBe(0);

describe("compareDeb (Debian policy §5.6.12)", () => {
  it("orders Ubuntu revisions the way apt does", () => {
    lt("1.20.1-1ubuntu0.7", "1.20.1-1ubuntu0.8");
    lt("1.20.1-1ubuntu0.8", "1.20.1-1ubuntu0.10");
    lt("3.0.2-0ubuntu1.10", "3.0.2-0ubuntu1.30");
    lt("5.15.0-202.212", "5.15.0-203.213");
    eq("2.35-0ubuntu3.15", "2.35-0ubuntu3.15");
  });
  it("epoch wins over everything after it; a missing epoch is 0", () => {
    lt("9.9-1", "1:0.1-1");
    lt("1:2.34.1-1ubuntu1.17", "1:2.34.1-1ubuntu1.18");
    eq("0:1.0-1", "1.0-1");
  });
  it("a tilde sorts before anything, even the end of the string", () => {
    lt("1.0~rc1-1", "1.0-1");
    lt("3.10.12-1~22.04.17", "3.10.12-1~22.04.18");
    lt("1.0~~", "1.0~");
  });
  it("letters sort before non-letters, numbers compare as numbers", () => {
    lt("1.0a", "1.0+");
    lt("1.2", "1.10");
    lt("2026d-0ubuntu0.22.04.1", "2026e-0ubuntu0.22.04.1");
  });
  it("no revision sorts before any revision of the same upstream", () => {
    lt("1.0", "1.0-1");
  });
});
