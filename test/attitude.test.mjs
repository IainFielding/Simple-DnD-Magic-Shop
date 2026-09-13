import { describe, expect, it } from "vitest";
import {
  DAY_SECONDS, adjustAttitude, attitudeTier, attitudeTierKey, clampAttitude, emptySpend,
  recordSpend, sanitizeSpend, startVisit, worldDay
} from "../scripts/data/attitude.mjs";

describe("clampAttitude", () => {
  it("holds the 0-100 bounds", () => {
    expect(clampAttitude(-40)).toBe(0);
    expect(clampAttitude(500)).toBe(100);
    expect(clampAttitude(50)).toBe(50);
  });

  it("rounds, so a stored fraction cannot drift", () => {
    expect(clampAttitude(62.4)).toBe(62);
    expect(clampAttitude(62.6)).toBe(63);
  });

  it("treats junk as the floor rather than propagating NaN", () => {
    expect(clampAttitude(undefined)).toBe(0);
    expect(clampAttitude("hello")).toBe(0);
    expect(clampAttitude(null)).toBe(0);
  });
});

describe("attitudeTierKey", () => {
  it("names each band", () => {
    expect(attitudeTierKey(0)).toBe("hostile");
    expect(attitudeTierKey(9)).toBe("hostile");
    expect(attitudeTierKey(10)).toBe("cold");
    expect(attitudeTierKey(24)).toBe("cold");
    expect(attitudeTierKey(25)).toBe("wary");
    expect(attitudeTierKey(39)).toBe("wary");
    expect(attitudeTierKey(40)).toBe("neutral");
    expect(attitudeTierKey(59)).toBe("neutral");
    expect(attitudeTierKey(60)).toBe("warm");
    expect(attitudeTierKey(74)).toBe("warm");
    expect(attitudeTierKey(75)).toBe("friendly");
    expect(attitudeTierKey(89)).toBe("friendly");
    expect(attitudeTierKey(90)).toBe("devoted");
    expect(attitudeTierKey(100)).toBe("devoted");
  });

  it("puts the default squarely in the neutral band", () => {
    expect(attitudeTierKey(50)).toBe("neutral");
  });

  it("covers the whole range with no gaps", () => {
    for ( let v = 0; v <= 100; v++ ) expect(typeof attitudeTierKey(v)).toBe("string");
  });

  it("never goes backwards as attitude rises", () => {
    const order = ["hostile", "cold", "wary", "neutral", "warm", "friendly", "devoted"];
    let last = 0;
    for ( let v = 0; v <= 100; v++ ) {
      const index = order.indexOf(attitudeTierKey(v));
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
  });

  it("carries a label beside the number, so colour is never the only cue", () => {
    const tier = attitudeTier(95);
    expect(tier.key).toBe("devoted");
    expect(tier.label).toContain("attitude.tier.devoted");
    expect(tier.value).toBe(95);
  });
});

describe("sanitizeSpend", () => {
  it("fills a missing record", () => {
    expect(sanitizeSpend(undefined)).toEqual(emptySpend());
    expect(sanitizeSpend("nonsense")).toEqual(emptySpend());
  });

  it("discards negative and non-numeric fields rather than trusting them", () => {
    expect(sanitizeSpend({ lifetimeCp: -500, visitCp: "x", visitEarned: 3.7, visitDay: 12 }))
      .toEqual({ lifetimeCp: 0, visitCp: 0, visitEarned: 4, visitDay: 12 });
  });
});

describe("worldDay", () => {
  it("buckets world time into in-game days", () => {
    expect(worldDay(0)).toBe(0);
    expect(worldDay(DAY_SECONDS - 1)).toBe(0);
    expect(worldDay(DAY_SECONDS)).toBe(1);
    expect(worldDay(DAY_SECONDS * 9.5)).toBe(9);
  });

  it("treats an unset world time as day zero", () => {
    expect(worldDay(undefined)).toBe(0);
  });
});

describe("startVisit", () => {
  it("leaves an in-progress visit alone", () => {
    const spend = { lifetimeCp: 500, visitCp: 300, visitEarned: 2, visitDay: 4 };
    expect(startVisit(spend, DAY_SECONDS * 4)).toEqual(spend);
  });

  it("rolls the visit counters over on a new day, keeping the lifetime total", () => {
    const spend = { lifetimeCp: 500, visitCp: 300, visitEarned: 2, visitDay: 4 };
    expect(startVisit(spend, DAY_SECONDS * 5)).toEqual({
      lifetimeCp: 500, visitCp: 0, visitEarned: 0, visitDay: 5
    });
  });
});

describe("recordSpend", () => {
  const opts = { worldTime: 0, cpPerPoint: 10_000, cap: 5 };

  it("earns a point per 100 gp spent", () => {
    const result = recordSpend({ spend: emptySpend(), spentCp: 30_000, ...opts });
    expect(result.points).toBe(3);
    expect(result.spend.visitEarned).toBe(3);
    expect(result.spend.lifetimeCp).toBe(30_000);
  });

  it("accumulates small purchases instead of rounding each one down to nothing", () => {
    // Six 20 gp purchases: each alone earns nothing, but together they cross 100 gp.
    let spend = emptySpend();
    let earned = 0;
    for ( let i = 0; i < 6; i++ ) {
      const result = recordSpend({ spend, spentCp: 2_000, ...opts });
      spend = result.spend;
      earned += result.points;
    }
    expect(spend.visitCp).toBe(12_000);
    expect(earned).toBe(1);
  });

  it("cannot be beaten by splitting a basket", () => {
    // One 1,000 gp purchase against ten 100 gp ones: the cap binds identically.
    const single = recordSpend({ spend: emptySpend(), spentCp: 100_000, ...opts });
    let spend = emptySpend();
    let split = 0;
    for ( let i = 0; i < 10; i++ ) {
      const result = recordSpend({ spend, spentCp: 10_000, ...opts });
      spend = result.spend;
      split += result.points;
    }
    expect(single.points).toBe(5);
    expect(split).toBe(5);
  });

  it("holds the per-visit cap however much is spent", () => {
    const result = recordSpend({ spend: emptySpend(), spentCp: 10_000_000, ...opts });
    expect(result.points).toBe(5);
  });

  it("cannot be reset by closing and reopening the shop — only by a new day", () => {
    // A visit is an in-game day, so re-entering on the same day is still the same visit.
    const first = recordSpend({ spend: emptySpend(), spentCp: 100_000, ...opts });
    expect(first.points).toBe(5);

    const sameDay = recordSpend({ spend: first.spend, spentCp: 100_000, ...opts });
    expect(sameDay.points).toBe(0);

    const nextDay = recordSpend({
      spend: sameDay.spend, spentCp: 100_000, worldTime: DAY_SECONDS, cpPerPoint: 10_000, cap: 5
    });
    expect(nextDay.points).toBe(5);
  });

  it("still books the spend when the drift is switched off", () => {
    const result = recordSpend({ spend: emptySpend(), spentCp: 50_000, worldTime: 0, cpPerPoint: 0, cap: 5 });
    expect(result.points).toBe(0);
    expect(result.spend.lifetimeCp).toBe(50_000);
  });

  it("earns nothing from a zero-cap world", () => {
    expect(recordSpend({ spend: emptySpend(), spentCp: 50_000, worldTime: 0, cpPerPoint: 10_000, cap: 0 }).points)
      .toBe(0);
  });

  it("ignores a negative or junk amount", () => {
    const result = recordSpend({ spend: emptySpend(), spentCp: -5_000, ...opts });
    expect(result.spend.lifetimeCp).toBe(0);
    expect(result.points).toBe(0);
  });
});

describe("adjustAttitude", () => {
  it("reports the move", () => {
    expect(adjustAttitude(50, 5)).toEqual({ from: 50, to: 55, changed: true });
    expect(adjustAttitude(50, -60)).toEqual({ from: 50, to: 0, changed: true });
  });

  it("reports no change at the ceiling, so a spending party stops writing documents", () => {
    // Without this an adored party would write a flag and fire a hook on every purchase forever.
    expect(adjustAttitude(100, 3)).toEqual({ from: 100, to: 100, changed: false });
    expect(adjustAttitude(0, -3)).toEqual({ from: 0, to: 0, changed: false });
    expect(adjustAttitude(50, 0)).toEqual({ from: 50, to: 50, changed: false });
  });
});
