import { beforeEach, describe, expect, it } from "vitest";
import { PRICING_PRESETS } from "../scripts/config.mjs";
import { priceMultipliers } from "../scripts/data/pricing.mjs";
import { ShopState } from "../scripts/app/shop-state.mjs";

const STANDARD = PRICING_PRESETS.standard;

/** A context payload of the shape `trade/context.mjs` produces. */
function context({ stock = [], pack = [], purseCp = 100_000, attitude = 50, chaMod = 0 } = {}) {
  const multipliers = priceMultipliers({ chaMod, attitude, anchors: STANDARD });
  return {
    trader: { id: "t1", name: "Dammon", purseCp: 95_500 },
    actor: { id: "a1", name: "Triss", chaMod, purseCp },
    attitude: { key: "neutral", label: "Neutral", value: attitude },
    multipliers: { buy: multipliers.buy, sell: multipliers.sell, favour: multipliers.favour },
    stock,
    pack
  };
}

const stockLine = (id, valueCp = 1000, qty = 5, extra = {}) => ({
  id, uuid: `Item.${id}`, name: id, img: "x.webp", type: "weapon", rarity: "",
  unlimited: false, qty, valueCp, buyCp: 0, price: "", ...extra
});

const packLine = (id, valueCp = 1000, qty = 1, extra = {}) => ({
  id, uuid: `Item.${id}`, name: id, img: "x.webp", type: "weapon", rarity: "",
  qty, valueCp, sellCp: 0, price: "", blocked: false, ...extra
});

describe("ShopState staging", () => {
  let state;

  beforeEach(() => {
    state = new ShopState();
    state.adopt(context({
      stock: [stockLine("sword", 1000, 3), stockLine("rations", 50, 1, { unlimited: true })],
      pack: [packLine("dagger", 200, 2), packLine("relic", 5000, 1, { blocked: true })]
    }));
  });

  it("starts empty in trade mode", () => {
    expect(state.mode).toBe("trade");
    expect(state.empty).toBe(true);
  });

  it("stages and unstages", () => {
    expect(state.stage("take", "sword", 1)).toBe(true);
    expect(state.staged("take", "sword")).toBe(1);
    expect(state.empty).toBe(false);
    expect(state.stage("take", "sword", -1)).toBe(true);
    expect(state.staged("take", "sword")).toBe(0);
    expect(state.empty).toBe(true);
  });

  it("clamps to available stock rather than failing at confirmation", () => {
    expect(state.stage("take", "sword", 10)).toBe(true);
    expect(state.staged("take", "sword")).toBe(3);
    // Already at the ceiling: nothing changed, so the caller can skip a re-render.
    expect(state.stage("take", "sword", 1)).toBe(false);
  });

  it("lets an unlimited line be staged without limit", () => {
    state.stage("take", "rations", 250);
    expect(state.staged("take", "rations")).toBe(250);
  });

  it("never goes below zero", () => {
    expect(state.stage("take", "sword", -5)).toBe(false);
    expect(state.staged("take", "sword")).toBe(0);
  });

  it("refuses a line the Trader will not buy", () => {
    expect(state.stage("give", "relic", 1)).toBe(false);
    expect(state.staged("give", "relic")).toBe(0);
  });

  it("refuses an id that is not in the context at all", () => {
    // The defence against a stale render: an id the payload does not carry cannot be staged.
    expect(state.stage("take", "does-not-exist", 1)).toBe(false);
  });

  it("clamps a character's own gear to what they hold", () => {
    state.stage("give", "dagger", 9);
    expect(state.staged("give", "dagger")).toBe(2);
  });
});

describe("ShopState.adopt", () => {
  it("trims a staged line whose item has gone", () => {
    const state = new ShopState();
    state.adopt(context({ stock: [stockLine("sword")] }));
    state.stage("take", "sword", 2);

    // The GM removed it while the shop was open.
    state.adopt(context({ stock: [] }));
    expect(state.staged("take", "sword")).toBe(0);
  });

  it("trims a staged quantity the Trader can no longer supply", () => {
    const state = new ShopState();
    state.adopt(context({ stock: [stockLine("sword", 1000, 5)] }));
    state.stage("take", "sword", 5);

    state.adopt(context({ stock: [stockLine("sword", 1000, 2)] }));
    expect(state.staged("take", "sword")).toBe(2);
  });

  it("drops a gear line the Trader has stopped accepting", () => {
    const state = new ShopState();
    state.adopt(context({ pack: [packLine("dagger")] }));
    state.stage("give", "dagger", 1);

    state.adopt(context({ pack: [packLine("dagger", 200, 1, { blocked: true })] }));
    expect(state.staged("give", "dagger")).toBe(0);
  });

  it("leaves a still-valid staging alone", () => {
    const state = new ShopState();
    state.adopt(context({ stock: [stockLine("sword", 1000, 5)] }));
    state.stage("take", "sword", 2);
    state.adopt(context({ stock: [stockLine("sword", 1000, 5)] }));
    expect(state.staged("take", "sword")).toBe(2);
  });
});

describe("ShopState totals in trade mode", () => {
  let state;

  beforeEach(() => {
    state = new ShopState();
    state.adopt(context({
      stock: [stockLine("sword", 1000, 3)],
      pack: [packLine("dagger", 1000, 2)],
      purseCp: 1000
    }));
  });

  it("costs the buy multiplier", () => {
    state.stage("take", "sword", 2);
    const totals = state.totals();
    expect(totals.costCp).toBe(2200);        // 1000 * 1.10 * 2
    expect(totals.creditCp).toBe(0);
    expect(totals.netCp).toBe(2200);
    expect(totals.owed).toBe(true);
  });

  it("credits the sell multiplier", () => {
    state.stage("give", "dagger", 2);
    const totals = state.totals();
    expect(totals.creditCp).toBe(900);       // 1000 * 0.45 * 2
    expect(totals.netCp).toBe(-900);
    expect(totals.owed).toBe(false);
  });

  it("nets a purchase against a sale in one confirmation", () => {
    // Trading the old sword toward the new one is the commonest thing anyone does in a shop;
    // making it two transactions would be worse in every way.
    state.stage("take", "sword", 1);
    state.stage("give", "dagger", 1);
    const totals = state.totals();
    expect(totals.costCp).toBe(1100);
    expect(totals.creditCp).toBe(450);
    expect(totals.netCp).toBe(650);
  });

  it("counts the sale's proceeds toward affording the purchase", () => {
    // A character with 10 gp must be able to trade a 250 gp greatsword for an 80 gp shield.
    const rich = new ShopState();
    rich.adopt(context({
      stock: [stockLine("shield", 8000, 1)],
      pack: [packLine("greatsword", 25_000, 1)],
      purseCp: 1000
    }));
    rich.stage("take", "shield", 1);
    expect(rich.totals().affordable).toBe(false);

    rich.stage("give", "greatsword", 1);
    const totals = rich.totals();
    expect(totals.costCp).toBe(8800);        // 8000 * 1.10
    expect(totals.creditCp).toBe(11_250);    // 25000 * 0.45
    expect(totals.netCp).toBe(-2450);
    expect(totals.affordable).toBe(true);
  });

  it("is unaffordable when the net exceeds the purse", () => {
    state.stage("take", "sword", 3);         // 3300 against a 1000 purse
    expect(state.totals().affordable).toBe(false);
  });

  it("is affordable at exactly the purse total", () => {
    const exact = new ShopState();
    exact.adopt(context({ stock: [stockLine("sword", 1000, 1)], purseCp: 1100 }));
    exact.stage("take", "sword", 1);
    expect(exact.totals().affordable).toBe(true);
  });
});

describe("ShopState totals in barter mode", () => {
  let state;

  beforeEach(() => {
    state = new ShopState();
    state.mode = "barter";
    state.adopt(context({
      stock: [stockLine("sword", 1000, 3)],
      pack: [packLine("dagger", 1000, 5)],
      purseCp: 5000
    }));
  });

  it("weighs the offer against the ask", () => {
    state.stage("take", "sword", 1);
    state.stage("give", "dagger", 1);
    const totals = state.totals();
    expect(totals.askCp).toBe(1100);
    expect(totals.offerCp).toBe(450);
    expect(totals.accepted).toBe(false);
  });

  it("accepts once the offer covers the ask", () => {
    state.stage("take", "sword", 1);
    state.stage("give", "dagger", 3);        // 1350 against 1100
    expect(state.totals().accepted).toBe(true);
  });

  it("lets coin balance the offer", () => {
    state.stage("take", "sword", 1);
    state.stage("give", "dagger", 1);
    state.goldCp = 700;                      // 450 + 700 = 1150 against 1100
    expect(state.totals().accepted).toBe(true);
  });

  it("will not let a character offer coin they do not hold", () => {
    state.stage("take", "sword", 1);
    state.goldCp = 999_999;
    const totals = state.totals();
    expect(totals.accepted).toBe(true);      // the Trader is happy
    expect(totals.affordable).toBe(false);   // the character cannot actually pay
  });
});

describe("ShopState coins", () => {
  /** A context whose actor carries a real purse by denomination, as the GM sends it. */
  const withPurse = currency => {
    const ctx = context({ stock: [stockLine("sword", 1000, 3)], purseCp: 0 });
    ctx.actor.currency = currency;
    return ctx;
  };

  it("stages coins by denomination and totals them in copper", () => {
    const state = new ShopState();
    state.adopt(withPurse({ pp: 2, gp: 10, ep: 0, sp: 5, cp: 0 }));
    state.setCoin("gp", 3);
    state.setCoin("sp", 5);
    expect(state.coins).toEqual({ gp: 3, sp: 5 });
    expect(state.goldCp).toBe(350);
  });

  it("caps each box at what the character holds of that coin", () => {
    const state = new ShopState();
    state.adopt(withPurse({ pp: 2, gp: 10, ep: 0, sp: 5, cp: 0 }));
    expect(state.setCoin("pp", 9)).toBe(2);
    expect(state.setCoin("ep", 4)).toBe(0);
    expect(state.coins).toEqual({ pp: 2 });
  });

  it("drops a coin from the offer when its box is cleared", () => {
    const state = new ShopState();
    state.adopt(withPurse({ pp: 0, gp: 10, ep: 0, sp: 0, cp: 0 }));
    state.setCoin("gp", 4);
    state.setCoin("gp", "");
    expect(state.coins).toEqual({});
    expect(state.empty).toBe(true);
  });

  it("judges affordability coin by coin, not just by total value", () => {
    // 50 gp in the purse is worth more than 3 pp, but it is not 3 pp.
    const state = new ShopState();
    state.mode = "barter";
    state.adopt(withPurse({ pp: 0, gp: 50, ep: 0, sp: 0, cp: 0 }));
    state.stage("take", "sword", 1);
    state.coins = { pp: 3 };
    expect(state.totals().affordable).toBe(false);
    state.coins = { gp: 30 };
    expect(state.totals().affordable).toBe(true);
  });

  it("puts the exact coins in a barter intent, and none in a cash trade", () => {
    const state = new ShopState();
    state.adopt(withPurse({ pp: 1, gp: 10, ep: 0, sp: 0, cp: 0 }));
    state.setCoin("pp", 1);
    state.setCoin("gp", 2);
    expect(state.intent().coins).toBeNull();

    state.mode = "barter";
    expect(state.intent().coins).toEqual({ pp: 1, gp: 2 });
    expect(state.intent().goldCp).toBe(1200);
  });

  it("clears the coins with the counter", () => {
    const state = new ShopState();
    state.adopt(withPurse({ pp: 0, gp: 10, ep: 0, sp: 0, cp: 0 }));
    state.setCoin("gp", 5);
    state.clear();
    expect(state.coins).toEqual({});
  });
});

describe("ShopState.intent", () => {
  it("carries ids and quantities only — never a price", () => {
    const state = new ShopState();
    state.adopt(context({
      stock: [stockLine("sword", 1000, 3)],
      pack: [packLine("dagger", 1000, 2)]
    }));
    state.stage("take", "sword", 2);
    state.stage("give", "dagger", 1);

    const intent = state.intent();
    expect(intent).toEqual({
      mode: "trade",
      buy: [{ id: "sword", qty: 2 }],
      sell: [{ id: "dagger", qty: 1 }],
      goldCp: 0,
      coins: null
    });
    // The security property, asserted rather than assumed: nothing price-shaped crosses back.
    const serialised = JSON.stringify(intent);
    expect(serialised).not.toMatch(/valueCp|buyCp|sellCp|multiplier|total|cost/i);
  });

  it("carries staged coin only in barter mode", () => {
    const state = new ShopState();
    state.adopt(context({ stock: [stockLine("sword")] }));
    state.goldCp = 500;
    expect(state.intent().goldCp).toBe(0);

    state.mode = "barter";
    expect(state.intent().goldCp).toBe(500);
  });
});
