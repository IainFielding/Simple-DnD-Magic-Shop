import { afterEach, describe, expect, it } from "vitest";
import { everythingUnlimited, stockLimit, stockLine } from "../scripts/data/trader.mjs";

const MODULE = "sogrom-simple-dnd5e-magic-shop";

/** A Trader with the given shop flags, and one stock item on it with its own line settings. */
const traderWith = (flags = {}, line = { unlimited: false, baseQty: 3 }) => {
  const actor = { flags: { [MODULE]: { isTrader: true, ...flags } } };
  const item = { parent: actor, flags: { [MODULE]: line } };
  return { actor, item };
};

describe("a Trader's shelf options", () => {
  afterEach(() => {
    delete globalThis.game;
  });

  it("are both off unless the GM turns them on", () => {
    const { actor, item } = traderWith();
    expect(everythingUnlimited(actor)).toBe(false);
    expect(stockLine(item).unlimited).toBe(false);
    expect(stockLimit(actor)).toBe(150);
  });

  it("make every line unlimited without touching the line's own setting", () => {
    const { actor, item } = traderWith({ allUnlimited: true });
    expect(everythingUnlimited(actor)).toBe(true);
    expect(stockLine(item)).toMatchObject({ unlimited: true, baseQty: 3 });
    expect(item.flags[MODULE].unlimited).toBe(false);
  });

  it("lift the line limit for that Trader alone", () => {
    globalThis.game = { settings: { get: () => 60 } };
    expect(stockLimit(traderWith({ noStockLimit: true }).actor)).toBe(Infinity);
    expect(stockLimit(traderWith().actor)).toBe(60);
  });

  it("only count when set to exactly true", () => {
    const { actor, item } = traderWith({ allUnlimited: "true", noStockLimit: 1 });
    expect(stockLine(item).unlimited).toBe(false);
    expect(stockLimit(actor)).toBe(150);
  });

  it("leave an item with no Trader alone", () => {
    expect(stockLine({ flags: { [MODULE]: { unlimited: false } } }).unlimited).toBe(false);
  });
});
