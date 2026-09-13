import { describe, expect, it } from "vitest";
import {
  HAGGLE_SKILLS, haggleDc, haggleDelta, haggleEdge, isHaggleLocked, lockHaggle, sanitizeHaggleRecord
} from "../scripts/data/haggle.mjs";

const DAY = 86_400;

describe("haggleDc", () => {
  it("is 15, or the Trader's Intelligence score when higher", () => {
    expect(haggleDc(10)).toBe(15);
    expect(haggleDc(18)).toBe(18);
    expect(haggleDc(undefined)).toBe(15);
  });
});

describe("haggleEdge", () => {
  it("gives advantage with a Friendly or Devoted Trader", () => {
    expect(haggleEdge(75)).toBe("advantage");
    expect(haggleEdge(95)).toBe("advantage");
  });

  it("gives disadvantage with a Cold or Hostile Trader", () => {
    expect(haggleEdge(24)).toBe("disadvantage");
    expect(haggleEdge(0)).toBe("disadvantage");
  });

  it("is a straight roll in between", () => {
    expect(haggleEdge(25)).toBe("normal");
    expect(haggleEdge(50)).toBe("normal");
    expect(haggleEdge(74)).toBe("normal");
  });
});

describe("the daily lockout", () => {
  it("locks a failed skill for the rest of the in-game day", () => {
    const record = lockHaggle({}, "per", DAY * 3 + 100);
    expect(isHaggleLocked(record, "per", DAY * 3 + 80_000)).toBe(true);
    expect(isHaggleLocked(record, "dec", DAY * 3 + 100)).toBe(false);
  });

  it("lifts at the next in-game day", () => {
    const record = lockHaggle({}, "per", DAY * 3);
    expect(isHaggleLocked(record, "per", DAY * 4)).toBe(false);
  });

  it("forgets yesterday's locks when a new one is recorded", () => {
    const record = lockHaggle({ per: 2, dec: 3 }, "itm", DAY * 3);
    expect(record).toEqual({ dec: 3, itm: 3 });
  });

  it("drops unknown skills and nonsense days", () => {
    expect(sanitizeHaggleRecord({ per: 4, ath: 4, dec: -1, itm: "x" })).toEqual({ per: 4 });
    expect(lockHaggle({}, "ath", 0)).toEqual({});
  });

  it("only names Charisma skills", () => {
    expect(HAGGLE_SKILLS).toEqual(["per", "dec", "itm", "prf"]);
  });
});

describe("haggleDelta", () => {
  it("raises on success and lowers on failure", () => {
    expect(haggleDelta(true, { gain: 5, loss: 5 })).toBe(5);
    expect(haggleDelta(false, { gain: 5, loss: 5 })).toBe(-5);
  });

  it("allows no penalty", () => {
    expect(haggleDelta(false, { gain: 5, loss: 0 })).toBe(0);
  });

  it("cannot be pushed off the scale", () => {
    expect(haggleDelta(true, { gain: 500 })).toBe(100);
    expect(haggleDelta(false, { loss: -20 })).toBe(0);
  });
});
