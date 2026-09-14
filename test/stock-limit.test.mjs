import { afterEach, describe, expect, it } from "vitest";
import { STOCK_LINES, maxStockLines } from "../scripts/config.mjs";
import { newLinesFromSale, stockRoom } from "../scripts/data/stock.mjs";
import { parseTraderExport } from "../scripts/data/portable.mjs";

/** Stand in for Foundry's settings store, holding one value for the stock limit. */
const withLimit = value => {
  globalThis.game = { settings: { get: () => value } };
};

describe("the stock limit", () => {
  afterEach(() => {
    delete globalThis.game;
  });

  it("is a 10 to 300 slider, 150 by default", () => {
    expect(STOCK_LINES).toEqual({ min: 10, max: 300, step: 10, default: 150 });
  });

  it("is 150 lines before the setting is registered", () => {
    expect(maxStockLines()).toBe(150);
  });

  it("follows the setting", () => {
    withLimit(300);
    expect(maxStockLines()).toBe(300);
    expect(stockRoom(250)).toBe(50);
  });

  it("holds a value set from the console to the slider's range", () => {
    withLimit(5000);
    expect(maxStockLines()).toBe(300);
    withLimit(0);
    expect(maxStockLines()).toBe(10);
    withLimit(212.7);
    expect(maxStockLines()).toBe(212);
    withLimit("abc");
    expect(maxStockLines()).toBe(150);
  });

  it("reports the room left, never below zero", () => {
    expect(stockRoom(0)).toBe(150);
    expect(stockRoom(149)).toBe(1);
    expect(stockRoom(150)).toBe(0);
    expect(stockRoom(212)).toBe(0);
    expect(stockRoom(40, 50)).toBe(10);
  });

  it("counts only the goods a sale would add as new lines", () => {
    const shelf = [{ type: "weapon", name: "Dagger" }, { type: "loot", name: "Ruby" }];
    expect(newLinesFromSale(shelf, [{ type: "weapon", name: "Dagger" }])).toBe(0);
    expect(newLinesFromSale(shelf, [{ type: "weapon", name: "Mace" }, { type: "weapon", name: "Mace" }])).toBe(1);
    // Same name, different type, is a different line — as the sale path merges it.
    expect(newLinesFromSale(shelf, [{ type: "equipment", name: "Dagger" }])).toBe(1);
  });

  it("imports at most the world's limit, and says how many it left out", () => {
    const file = {
      format: "sogrom-simple-dnd5e-magic-shop.trader", version: 1,
      trader: { name: "Hoarder" },
      items: Array.from({ length: 320 }, (_, i) => ({ name: `Rock ${i}`, type: "loot" }))
    };
    const parsed = parseTraderExport(file);
    expect(parsed.items).toHaveLength(150);
    expect(parsed.dropped).toBe(170);

    withLimit(300);
    expect(parseTraderExport(file).dropped).toBe(20);
  });
});
