import { describe, expect, it } from "vitest";
import { DAY_SECONDS } from "../scripts/data/attitude.mjs";
import {
  daysUntilRestock, defaultRestock, dueForRestock, restockPlan, sanitizeRestock
} from "../scripts/data/restock.mjs";

const days = n => n * DAY_SECONDS;

/** One stock entry as the plan function expects it. */
const entry = (id, quantity, line = {}) => ({
  id, line, item: { system: { quantity } }
});

describe("sanitizeRestock", () => {
  it("defaults to manual, so nothing refills unless a GM asked for it", () => {
    expect(sanitizeRestock(undefined)).toEqual(defaultRestock());
    expect(sanitizeRestock(undefined).mode).toBe("manual");
  });

  it("falls back to manual for an unrecognised mode rather than to a schedule", () => {
    // A stale or hand-edited value must not make a Trader start refilling on a schedule
    // nobody set.
    expect(sanitizeRestock({ mode: "weekly" }).mode).toBe("manual");
    expect(sanitizeRestock({ mode: "time" }).mode).toBe("time");
    expect(sanitizeRestock({ mode: "none" }).mode).toBe("none");
  });

  it("keeps the interval sane", () => {
    expect(sanitizeRestock({ days: 0 }).days).toBe(7);
    expect(sanitizeRestock({ days: -3 }).days).toBe(7);
    expect(sanitizeRestock({ days: 2.6 }).days).toBe(3);
    expect(sanitizeRestock({ days: 99_999 }).days).toBe(3650);
  });
});

describe("dueForRestock", () => {
  it("is never due in manual or none mode", () => {
    for ( const mode of ["manual", "none"] ) {
      expect(dueForRestock({ mode, days: 1, lastAt: 0 }, days(400))).toBe(false);
    }
  });

  it("is not due before the interval has passed", () => {
    const config = { mode: "time", days: 7, lastAt: days(10) };
    expect(dueForRestock(config, days(10))).toBe(false);
    expect(dueForRestock(config, days(16))).toBe(false);
  });

  it("is due once the interval has passed", () => {
    const config = { mode: "time", days: 7, lastAt: days(10) };
    expect(dueForRestock(config, days(17))).toBe(true);
    expect(dueForRestock(config, days(40))).toBe(true);
  });

  it("measures whole days, so dusk and dawn give the same answer", () => {
    const config = { mode: "time", days: 1, lastAt: days(3) };
    // Same in-game day, eighteen hours later: still the same day, so not yet due.
    expect(dueForRestock(config, days(3) + (18 * 3600))).toBe(false);
    expect(dueForRestock(config, days(4))).toBe(true);
  });

  it("is not due on a brand-new Trader in a world whose clock has never moved", () => {
    expect(dueForRestock({ mode: "time", days: 7, lastAt: 0 }, 0)).toBe(false);
  });
});

describe("daysUntilRestock", () => {
  it("counts down, and reports zero when due", () => {
    const config = { mode: "time", days: 7, lastAt: days(10) };
    expect(daysUntilRestock(config, days(10))).toBe(7);
    expect(daysUntilRestock(config, days(13))).toBe(4);
    expect(daysUntilRestock(config, days(17))).toBe(0);
    expect(daysUntilRestock(config, days(90))).toBe(0);
  });

  it("reports null for a Trader that never restocks on its own", () => {
    expect(daysUntilRestock({ mode: "manual" }, days(9))).toBeNull();
    expect(daysUntilRestock({ mode: "none" }, days(9))).toBeNull();
  });
});

describe("restockPlan", () => {
  it("refills a depleted line to its baseline", () => {
    const plan = restockPlan([entry("a", 2, { baseQty: 10 })], days(5));
    expect(plan.updates).toEqual([{ _id: "a", "system.quantity": 10 }]);
    expect(plan.added).toEqual([{ itemId: "a", from: 2, to: 10 }]);
    expect(plan.lastAt).toBe(days(5));
  });

  it("refills a sold-out line", () => {
    const plan = restockPlan([entry("a", 0, { baseQty: 3 })], 0);
    expect(plan.updates).toEqual([{ _id: "a", "system.quantity": 3 }]);
  });

  it("never trims a line the GM has stocked above its baseline", () => {
    // Restocking is replenishment, not enforcement of a target: a GM who hand-sets 50 because
    // the party emptied a caravan must not have it cut back to 10.
    const plan = restockPlan([entry("a", 50, { baseQty: 10 })], 0);
    expect(plan.updates).toEqual([]);
    expect(plan.added).toEqual([]);
  });

  it("leaves a line that is already exactly at its baseline alone", () => {
    expect(restockPlan([entry("a", 10, { baseQty: 10 })], 0).updates).toEqual([]);
  });

  it("skips unlimited lines, which cannot run out", () => {
    expect(restockPlan([entry("a", 1, { unlimited: true, baseQty: 10 })], 0).updates).toEqual([]);
  });

  it("writes nothing for a Trader whose shelves are already full", () => {
    const plan = restockPlan([
      entry("a", 10, { baseQty: 10 }),
      entry("b", 99, { baseQty: 5 }),
      entry("c", 1, { unlimited: true })
    ], 0);
    expect(plan.updates).toEqual([]);
  });

  it("returns only the lines that change", () => {
    const plan = restockPlan([
      entry("full", 10, { baseQty: 10 }),
      entry("empty", 0, { baseQty: 4 }),
      entry("part", 1, { baseQty: 2 })
    ], 0);
    expect(plan.updates.map(u => u._id)).toEqual(["empty", "part"]);
  });

  it("treats a junk quantity as empty and refills it", () => {
    const plan = restockPlan([{ id: "a", line: { baseQty: 2 }, item: { system: {} } }], 0);
    expect(plan.added).toEqual([{ itemId: "a", from: 0, to: 2 }]);
  });

  it("survives an empty or missing shelf", () => {
    expect(restockPlan([], 0).updates).toEqual([]);
    expect(restockPlan(undefined, 0).updates).toEqual([]);
  });
});
