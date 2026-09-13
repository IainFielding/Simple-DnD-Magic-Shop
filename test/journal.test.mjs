import { describe, expect, it } from "vitest";
import { Journal, currencyDelta, reverseCurrency } from "../scripts/trade/journal.mjs";

describe("Journal", () => {
  it("undoes writes newest first", async () => {
    const order = [];
    const journal = new Journal();
    journal.record("coin", async () => order.push("coin"));
    journal.record("shelf", async () => order.push("shelf"));
    journal.record("pack", async () => order.push("pack"));
    const { undone, failed } = await journal.rollback();
    expect(order).toEqual(["pack", "shelf", "coin"]);
    expect(undone).toEqual(["pack", "shelf", "coin"]);
    expect(failed).toEqual([]);
  });

  it("carries on past a reversal that fails, and reports it", async () => {
    const order = [];
    const journal = new Journal();
    journal.record("coin", async () => order.push("coin"));
    journal.record("shelf", async () => {
      throw new Error("gone");
    });
    const { undone, failed } = await journal.rollback();
    expect(order).toEqual(["coin"]);
    expect(undone).toEqual(["coin"]);
    expect(failed.map(f => f.label)).toEqual(["shelf"]);
  });

  it("is empty after a rollback, so nothing is undone twice", async () => {
    let count = 0;
    const journal = new Journal();
    journal.record("coin", async () => count++);
    await journal.rollback();
    await journal.rollback();
    expect(count).toBe(1);
    expect(journal.size).toBe(0);
  });
});

describe("currencyDelta", () => {
  it("records only the coins that changed", () => {
    expect(currencyDelta({ gp: 10, sp: 5, cp: 0 }, { gp: 7, sp: 5, cp: 3 })).toEqual({ gp: -3, cp: 3 });
  });

  it("treats a missing denomination as zero", () => {
    expect(currencyDelta({}, { pp: 1 })).toEqual({ pp: 1 });
  });
});

describe("reverseCurrency", () => {
  it("takes the change back out of the purse as it is now, not as it was", () => {
    // The purse was 10 gp, a trade took 3, and the character has since spent 2 more elsewhere.
    // A snapshot restore would write 10 back and erase that spend; the delta gives back 3.
    expect(reverseCurrency({ gp: 5 }, { gp: -3 })).toEqual({ "system.currency.gp": 8 });
  });

  it("never drives a coin negative", () => {
    expect(reverseCurrency({ gp: 1 }, { gp: 4 })).toEqual({ "system.currency.gp": 0 });
  });
});
