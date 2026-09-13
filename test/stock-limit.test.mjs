import { describe, expect, it } from "vitest";
import { MAX_STOCK_LINES } from "../scripts/config.mjs";
import { newLinesFromSale, stockRoom } from "../scripts/data/stock.mjs";
import { IMPORT_ITEM_LIMIT, parseTraderExport } from "../scripts/data/portable.mjs";

describe("the stock limit", () => {
  it("is 150 lines", () => {
    expect(MAX_STOCK_LINES).toBe(150);
  });

  it("reports the room left, never below zero", () => {
    expect(stockRoom(0)).toBe(150);
    expect(stockRoom(149)).toBe(1);
    expect(stockRoom(150)).toBe(0);
    expect(stockRoom(212)).toBe(0);
  });

  it("counts only the goods a sale would add as new lines", () => {
    const shelf = [{ type: "weapon", name: "Dagger" }, { type: "loot", name: "Ruby" }];
    expect(newLinesFromSale(shelf, [{ type: "weapon", name: "Dagger" }])).toBe(0);
    expect(newLinesFromSale(shelf, [{ type: "weapon", name: "Mace" }, { type: "weapon", name: "Mace" }])).toBe(1);
    // Same name, different type, is a different line — as the sale path merges it.
    expect(newLinesFromSale(shelf, [{ type: "equipment", name: "Dagger" }])).toBe(1);
  });

  it("imports at most the limit, and says how many it left out", () => {
    expect(IMPORT_ITEM_LIMIT).toBe(MAX_STOCK_LINES);
    const file = {
      format: "sogrom-simple-dnd5e-magic-shop.trader", version: 1,
      trader: { name: "Hoarder" },
      items: Array.from({ length: 160 }, (_, i) => ({ name: `Rock ${i}`, type: "loot" }))
    };
    const parsed = parseTraderExport(file);
    expect(parsed.items).toHaveLength(150);
    expect(parsed.dropped).toBe(10);
  });
});
