import { describe, expect, it } from "vitest";
import { PRICING_PRESETS } from "../scripts/config.mjs";
import {
  barterBalance, favour, favourBreakdown, goodwillSpendCp, lineMultiplier, priceBasket, priceMultipliers
} from "../scripts/data/pricing.mjs";
import { isFixedValue, transferData } from "../scripts/data/stock.mjs";
import { ShopState } from "../scripts/app/shop-state.mjs";
import { attributionTable, escapeHtml, lineBreakdown, rateBreakdown, signed, times } from "../scripts/app/price-breakdown.mjs";

const STANDARD = PRICING_PRESETS.standard;

describe("isFixedValue", () => {
  const loot = subtype => ({ type: "loot", system: { type: { value: subtype } } });

  it("marks gems, art objects and trade goods", () => {
    expect(isFixedValue(loot("gem"))).toBe(true);
    expect(isFixedValue(loot("art"))).toBe(true);
    expect(isFixedValue(loot("trade"))).toBe(true);
  });

  it("leaves other loot and other types alone", () => {
    expect(isFixedValue(loot("junk"))).toBe(false);
    expect(isFixedValue({ type: "weapon", system: { type: { value: "gem" } } })).toBe(false);
  });

  it("is switched off by the world setting", () => {
    expect(isFixedValue(loot("gem"), false)).toBe(false);
  });
});

describe("full-value pricing", () => {
  const multipliers = priceMultipliers({ chaMod: -2, attitude: 20, anchors: STANDARD });

  it("prices a fixed line at x1 whatever the multiplier", () => {
    expect(lineMultiplier(1.4, true)).toBe(1);
    expect(lineMultiplier(1.4, false)).toBe(1.4);
    const basket = priceBasket([
      { id: "ruby", valueCp: 50_000, qty: 2, fixed: true },
      { id: "sword", valueCp: 1500, qty: 1 }
    ], multipliers.buy);
    expect(basket.lines[0].unitCp).toBe(50_000);
    expect(basket.lines[1].unitCp).toBe(Math.round(1500 * multipliers.buy));
  });

  it("carries through a barter on both sides", () => {
    const balance = barterBalance({
      take: [{ id: "pearl", valueCp: 10_000, qty: 1, fixed: true }],
      give: [{ id: "garnet", valueCp: 10_000, qty: 1, fixed: true }],
      multipliers
    });
    expect(balance.accepted).toBe(true);
    expect(balance.balanceCp).toBe(0);
  });
});

describe("goodwillSpendCp", () => {
  it("counts coin paid for ordinary goods", () => {
    expect(goodwillSpendCp({ mode: "trade", costCp: 5000, netCp: 5000 })).toBe(5000);
  });

  it("does not count full-value goods, so buying a gem and selling it back earns nothing", () => {
    expect(goodwillSpendCp({ mode: "trade", costCp: 50_000, fixedCostCp: 50_000, netCp: 50_000 })).toBe(0);
  });

  it("caps at the ordinary goods when a purchase mixes both", () => {
    expect(goodwillSpendCp({ mode: "trade", costCp: 51_500, fixedCostCp: 50_000, netCp: 51_500 })).toBe(1500);
  });

  it("nets a sale off, as before", () => {
    expect(goodwillSpendCp({ mode: "trade", costCp: 5000, netCp: 1000 })).toBe(1000);
    expect(goodwillSpendCp({ mode: "trade", costCp: 0, netCp: -4000 })).toBe(0);
  });

  it("counts a barter's offer, capped the same way", () => {
    expect(goodwillSpendCp({ mode: "barter", costCp: 3000, creditCp: 3500 })).toBe(3000);
    expect(goodwillSpendCp({ mode: "barter", costCp: 3000, fixedCostCp: 3000, creditCp: 3000 })).toBe(0);
  });
});

describe("favourBreakdown", () => {
  it("adds up to the favour that priced the goods", () => {
    const parts = favourBreakdown({ chaMod: 3, attitude: 64 });
    expect(parts.chaFavour + parts.attitudeFavour).toBeCloseTo(favour({ chaMod: 3, attitude: 64 }));
    expect(parts.total).toBeCloseTo(0.52);
    expect(parts.clamped).toBe(false);
  });

  it("says when the parts ran off the end of the curve", () => {
    expect(favourBreakdown({ chaMod: 5, attitude: 100 }).clamped).toBe(false);
    expect(favourBreakdown({ chaMod: 5, attitude: 100 }).total).toBe(1);
  });
});

describe("transferData", () => {
  const source = {
    _id: "abc", name: "Cloak of Protection", type: "equipment",
    system: { quantity: 1, equipped: true, attuned: true, attunement: "required" }
  };

  it("clears equipped and attuned, and sets the quantity", () => {
    const data = transferData(source, 3);
    expect(data._id).toBeUndefined();
    expect(data.system).toMatchObject({ quantity: 3, equipped: false, attuned: false, attunement: "required" });
  });

  it("does not add fields an item never had", () => {
    const data = transferData({ type: "loot", system: { quantity: 5 } }, 2);
    expect(data.system).toEqual({ quantity: 2 });
  });

  it("does not modify the source", () => {
    transferData(source, 3);
    expect(source.system.equipped).toBe(true);
    expect(source._id).toBe("abc");
  });
});

describe("ShopState with full-value goods", () => {
  it("totals a gem at its list value, and a sword at the character's price", () => {
    const multipliers = priceMultipliers({ chaMod: 0, attitude: 50, anchors: STANDARD });
    const state = new ShopState();
    state.adopt({
      trader: { id: "t" }, actor: { id: "a", purseCp: 1_000_000 },
      multipliers,
      stock: [
        { id: "ruby", valueCp: 50_000, qty: 1, fixed: true },
        { id: "sword", valueCp: 1500, qty: 1 }
      ],
      pack: []
    });
    state.stage("take", "ruby", 1);
    state.stage("take", "sword", 1);
    expect(state.totals().costCp).toBe(50_000 + Math.round(1500 * multipliers.buy));
  });
});

describe("price breakdown tooltips", () => {
  const labels = {
    caption: "Why", listValue: "List", fullValue: "Full value", adjusted: "House rule",
    charisma: mod => `CHA ${mod}`, attitude: (v, tier) => `Att ${v} ${tier}`,
    youPay: "You pay", theyPay: "They pay", favour: "Favour", each: "Each"
  };
  const pricing = { chaMod: 2, chaFavour: 0.3, attitude: 64, attitudeFavour: 0.07, total: 0.37, tier: "Warm", buy: 0.99, sell: 0.51, adjusted: false };

  it("formats figures", () => {
    expect(signed(0.3)).toBe("+0.30");
    expect(signed(-0.12)).toBe("−0.12");
    expect(signed(0.001)).toBe("0.00");
    expect(times(0.861)).toBe("×0.86");
  });

  it("escapes names that land in markup", () => {
    expect(escapeHtml(`<b>"Vex's"</b>`)).toBe("&lt;b&gt;&quot;Vex&#39;s&quot;&lt;/b&gt;");
    expect(attributionTable({ rows: [{ value: "1", label: "<x>" }] })).toContain("&lt;x&gt;");
  });

  it("shows where a staged price comes from", () => {
    const html = lineBreakdown({ line: { valueCp: 5000, buyCp: 4950 }, side: "take", pricing, labels });
    expect(html).toContain("CHA 2");
    expect(html).toContain("Att 64 Warm");
    expect(html).toContain("×0.99");
    expect(html).toContain("49 gp 5 sp");
  });

  it("says a full-value line is full value, without the favour terms", () => {
    const html = lineBreakdown({ line: { valueCp: 5000, sellCp: 5000, fixed: true }, side: "give", pricing, labels });
    expect(html).toContain("Full value");
    expect(html).not.toContain("CHA");
  });

  it("names a house rule when one changed the multipliers", () => {
    expect(rateBreakdown({ ...pricing, adjusted: true }, labels)).toContain("House rule");
    expect(rateBreakdown(pricing, labels)).not.toContain("House rule");
    expect(rateBreakdown(null, labels)).toBe("");
  });
});
