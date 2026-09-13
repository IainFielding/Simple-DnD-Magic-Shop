import { describe, expect, it } from "vitest";
import { PRICING_PRESETS } from "../scripts/config.mjs";
import {
  ATTITUDE_CENTRE, applyMultiplier, barterBalance, copperPerUnit, favour, formatCp,
  itemValueCp, multiplierBounds, priceBasket, priceMultipliers, pricesFor, toCopper,
  totalCp, validateAnchors
} from "../scripts/data/pricing.mjs";

const STANDARD = PRICING_PRESETS.standard;

/** Round to two places for comparison against the documented tables. */
const r2 = n => Math.round(n * 100) / 100;

describe("currency", () => {
  it("derives copper-per-unit from the system's conversion table", () => {
    expect(copperPerUnit("cp")).toBe(1);
    expect(copperPerUnit("sp")).toBe(10);
    expect(copperPerUnit("gp")).toBe(100);
    expect(copperPerUnit("ep")).toBe(50);
    expect(copperPerUnit("pp")).toBe(1000);
  });

  it("normalises amounts to whole copper", () => {
    expect(toCopper(15, "gp")).toBe(1500);
    expect(toCopper(7, "sp")).toBe(70);
    expect(toCopper(1, "pp")).toBe(1000);
    expect(toCopper(0.5, "gp")).toBe(50);
  });

  it("treats junk as nothing rather than NaN", () => {
    expect(toCopper(undefined, "gp")).toBe(0);
    expect(toCopper("abc", "gp")).toBe(0);
    expect(totalCp(null)).toBe(0);
  });

  it("sums a mixed purse", () => {
    // 2 pp + 3 gp + 4 sp + 5 cp = 2000 + 300 + 40 + 5
    expect(totalCp({ pp: 2, gp: 3, sp: 4, cp: 5 })).toBe(2345);
  });

  it("reads an item's list value, and reports an unpriced item as zero", () => {
    expect(itemValueCp({ value: 15, denomination: "gp" })).toBe(1500);
    expect(itemValueCp({ value: 0, denomination: "gp" })).toBe(0);
    expect(itemValueCp(null)).toBe(0);
    // A negative price is data corruption, not a discount.
    expect(itemValueCp({ value: -5, denomination: "gp" })).toBe(0);
  });

  it("formats largest-denomination-first, and never renders an empty string", () => {
    expect(formatCp(1500)).toBe("15 gp");
    expect(formatCp(75)).toBe("7 sp 5 cp");
    expect(formatCp(1)).toBe("1 cp");
    expect(formatCp(0)).toBe("0 cp");
    expect(formatCp(1605)).toBe("16 gp 5 cp");
  });

  it("groups large figures so 1650 cannot be misread as 165", () => {
    expect(formatCp(165_000)).toBe("1,650 gp");
  });
});

describe("favour", () => {
  it("puts a Charisma 10 stranger at exactly zero", () => {
    expect(favour({ chaMod: 0, attitude: ATTITUDE_CENTRE })).toBe(0);
  });

  it("reaches the extremes exactly, so nothing is lost to the clamp", () => {
    expect(favour({ chaMod: 5, attitude: 100 })).toBeCloseTo(1, 10);
    expect(favour({ chaMod: -5, attitude: 0 })).toBeCloseTo(-1, 10);
  });

  it("weights Charisma at three times the whole attitude scale", () => {
    const chaSpan = favour({ chaMod: 5, attitude: 50 }) - favour({ chaMod: -5, attitude: 50 });
    const attSpan = favour({ chaMod: 0, attitude: 100 }) - favour({ chaMod: 0, attitude: 0 });
    expect(r2(chaSpan)).toBe(1.5);
    expect(r2(attSpan)).toBe(0.5);
    expect(r2(chaSpan / attSpan)).toBe(3);
  });

  it("makes one point of Charisma modifier worth 30 points of attitude", () => {
    const onePointOfCha = favour({ chaMod: 1, attitude: 50 });
    const thirtyOfAttitude = favour({ chaMod: 0, attitude: 80 });
    expect(r2(onePointOfCha)).toBe(r2(thirtyOfAttitude));
  });

  it("clamps a homebrew Charisma score into the curve", () => {
    expect(favour({ chaMod: 12, attitude: 50 })).toBe(favour({ chaMod: 5, attitude: 50 }));
    expect(favour({ chaMod: 0, attitude: 400 })).toBe(favour({ chaMod: 0, attitude: 100 }));
  });

  it("survives missing arguments as a neutral stranger", () => {
    expect(favour()).toBe(0);
    expect(favour({})).toBe(0);
  });
});

describe("the documented multiplier table (docs/PLAN.md §3.3)", () => {
  /**
   * The published table, verbatim, as `chaMod -> attitude -> [buy, sell]`. This is the contract
   * the plan makes with the GM reading it, so a change to the model that is *not* also a change
   * to the documentation fails here.
   */
  const TABLE = {
    "-1": { 0: [1.30, 0.39], 25: [1.24, 0.41], 50: [1.18, 0.43], 75: [1.11, 0.45], 100: [1.07, 0.47] },
    0: { 0: [1.23, 0.41], 25: [1.16, 0.43], 50: [1.10, 0.45], 75: [1.06, 0.47], 100: [1.03, 0.49] },
    1: { 0: [1.15, 0.44], 25: [1.09, 0.45], 50: [1.06, 0.48], 75: [1.02, 0.50], 100: [0.98, 0.52] },
    2: { 0: [1.09, 0.46], 25: [1.05, 0.48], 50: [1.01, 0.50], 75: [0.97, 0.52], 100: [0.94, 0.54] },
    3: { 0: [1.04, 0.48], 25: [1.00, 0.51], 50: [0.97, 0.53], 75: [0.93, 0.55], 100: [0.89, 0.57] },
    4: { 0: [1.00, 0.51], 25: [0.96, 0.53], 50: [0.92, 0.55], 75: [0.88, 0.57], 100: [0.85, 0.59] },
    5: { 0: [0.95, 0.54], 25: [0.91, 0.56], 50: [0.88, 0.58], 75: [0.84, 0.60], 100: [0.80, 0.62] }
  };

  for ( const [chaMod, row] of Object.entries(TABLE) ) {
    for ( const [attitude, [buy, sell]] of Object.entries(row) ) {
      it(`CHA mod ${chaMod} at attitude ${attitude} buys at ${buy} and sells at ${sell}`, () => {
        const m = priceMultipliers({
          chaMod: Number(chaMod), attitude: Number(attitude), anchors: STANDARD
        });
        expect(r2(m.buy)).toBe(buy);
        expect(r2(m.sell)).toBe(sell);
      });
    }
  }

  it("prices Plate Armour as the plan's worked example says", () => {
    const plate = toCopper(1500, "gp");
    const cases = [
      [0, 0, "1,837 gp 5 sp", "618 gp 7 sp 5 cp"],
      [0, 50, "1,650 gp", "675 gp"],
      [0, 100, "1,537 gp 5 sp", "738 gp 7 sp 5 cp"],
      [5, 50, "1,312 gp 5 sp", "866 gp 2 sp 5 cp"],
      [5, 100, "1,200 gp", "930 gp"]
    ];
    for ( const [chaMod, attitude, buy, sell] of cases ) {
      const m = priceMultipliers({ chaMod, attitude, anchors: STANDARD });
      const { buyCp, sellCp } = pricesFor(plate, m);
      expect(formatCp(buyCp), `CHA ${chaMod} / attitude ${attitude} buy`).toBe(buy);
      expect(formatCp(sellCp), `CHA ${chaMod} / attitude ${attitude} sell`).toBe(sell);
    }
  });
});

describe("the no-arbitrage invariant", () => {
  it("holds for every shipped preset: the cheapest buy beats the best sell", () => {
    for ( const [name, anchors] of Object.entries(PRICING_PRESETS) ) {
      const { minBuy, maxSell } = multiplierBounds(anchors);
      expect(minBuy, `${name}: min buy must exceed max sell`).toBeGreaterThan(maxSell);
    }
  });

  it("holds across every reachable Favour, in both directions", () => {
    // Sweep the whole space rather than the corners: a non-monotonic anchor set would put the
    // cheapest buy somewhere in the middle, and only a sweep would catch it.
    for ( const anchors of Object.values(PRICING_PRESETS) ) {
      let minBuy = Infinity;
      let maxSell = -Infinity;
      for ( let chaMod = -5; chaMod <= 5; chaMod++ ) {
        for ( let attitude = 0; attitude <= 100; attitude++ ) {
          const m = priceMultipliers({ chaMod, attitude, anchors });
          minBuy = Math.min(minBuy, m.buy);
          maxSell = Math.max(maxSell, m.sell);
        }
      }
      expect(minBuy).toBeGreaterThan(maxSell);
    }
  });

  it("means a round trip always loses money, even at maximum goodwill", () => {
    const m = priceMultipliers({ chaMod: 5, attitude: 100, anchors: STANDARD });
    const value = toCopper(100, "gp");
    const { buyCp, sellCp } = pricesFor(value, m);
    expect(sellCp).toBeLessThan(buyCp);
  });

  it("means buying from a devoted Trader and selling to a hostile one loses more", () => {
    const devoted = priceMultipliers({ chaMod: 5, attitude: 100, anchors: STANDARD });
    const hostile = priceMultipliers({ chaMod: -5, attitude: 0, anchors: STANDARD });
    const value = toCopper(100, "gp");
    expect(applyMultiplier(value, hostile.sell)).toBeLessThan(applyMultiplier(value, devoted.buy));
  });
});

describe("applyMultiplier", () => {
  it("never makes a priced item free", () => {
    expect(applyMultiplier(1, 0.001)).toBe(1);
  });

  it("leaves an unpriced item at zero rather than making it free", () => {
    expect(applyMultiplier(0, 0.8)).toBe(0);
  });

  it("falls back to list value for a nonsense multiplier", () => {
    expect(applyMultiplier(1000, -1)).toBe(1000);
    expect(applyMultiplier(1000, NaN)).toBe(1000);
  });

  it("rounds to whole copper", () => {
    expect(applyMultiplier(101, 1.105)).toBe(112);
  });
});

describe("validateAnchors", () => {
  it("accepts every shipped preset", () => {
    for ( const [name, anchors] of Object.entries(PRICING_PRESETS) ) {
      expect(validateAnchors(anchors), name).toEqual({ ok: true, errors: [] });
    }
  });

  it("rejects a set where goodwill opens an arbitrage window", () => {
    const bad = {
      hostile: { buy: 1.6, sell: 0.3 },
      neutral: { buy: 1.1, sell: 0.45 },
      devoted: { buy: 0.5, sell: 0.7 }
    };
    const result = validateAnchors(bad);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("arbitrage");
  });

  it("rejects a set where being liked makes buying more expensive", () => {
    const bad = {
      hostile: { buy: 1.0, sell: 0.3 },
      neutral: { buy: 1.1, sell: 0.45 },
      devoted: { buy: 1.2, sell: 0.62 }
    };
    expect(validateAnchors(bad).errors).toContain("buyNotMonotonic");
  });

  it("rejects a set where being liked pays less for your goods", () => {
    const bad = {
      hostile: { buy: 1.6, sell: 0.62 },
      neutral: { buy: 1.1, sell: 0.45 },
      devoted: { buy: 0.8, sell: 0.30 }
    };
    expect(validateAnchors(bad).errors).toContain("sellNotMonotonic");
  });

  it("names every missing or non-positive number, and stops before comparing", () => {
    const result = validateAnchors({ neutral: { buy: 1.1, sell: 0 } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("notPositive.neutral.sell");
    expect(result.errors).toContain("notPositive.hostile.buy");
    // The monotonicity checks would be noise on top of the real fault.
    expect(result.errors).not.toContain("buyNotMonotonic");
  });
});

describe("priceBasket", () => {
  const m = priceMultipliers({ chaMod: 0, attitude: 50, anchors: STANDARD });

  it("totals a basket and itemises each line", () => {
    const basket = priceBasket([
      { id: "a", valueCp: 1500, qty: 2 },
      { id: "b", valueCp: 50, qty: 3 }
    ], m.buy);
    // 1500 * 1.10 = 1650 each; 50 * 1.10 = 55 each.
    expect(basket.lines).toEqual([
      { id: "a", qty: 2, unitCp: 1650, lineCp: 3300 },
      { id: "b", qty: 3, unitCp: 55, lineCp: 165 }
    ]);
    expect(basket.totalCp).toBe(3465);
  });

  it("drops lines with no quantity rather than pricing nothing", () => {
    const basket = priceBasket([
      { id: "a", valueCp: 1500, qty: 0 },
      { id: "b", valueCp: 1500, qty: -2 },
      { id: "c", valueCp: 1500, qty: 1.7 }
    ], m.buy);
    // 1.7 floors to 1: a fractional quantity is a bug upstream, not half an item.
    expect(basket.lines.map(l => l.id)).toEqual(["c"]);
    expect(basket.lines[0].qty).toBe(1);
  });

  it("survives an empty or missing basket", () => {
    expect(priceBasket([], m.buy).totalCp).toBe(0);
    expect(priceBasket(undefined, m.buy).totalCp).toBe(0);
  });
});

describe("barterBalance", () => {
  const m = priceMultipliers({ chaMod: 0, attitude: 50, anchors: STANDARD });

  it("values the Trader's goods at the buy rate and the character's at the sell rate", () => {
    const result = barterBalance({
      take: [{ id: "t", valueCp: 1000, qty: 1 }],
      give: [{ id: "g", valueCp: 1000, qty: 1 }],
      multipliers: m
    });
    expect(result.askCp).toBe(1100);   // 1000 * 1.10
    expect(result.offerCp).toBe(450);  // 1000 * 0.45
    expect(result.accepted).toBe(false);
  });

  it("accepts once the offer covers the ask", () => {
    const result = barterBalance({
      take: [{ id: "t", valueCp: 1000, qty: 1 }],
      give: [{ id: "g", valueCp: 1000, qty: 3 }],
      multipliers: m
    });
    expect(result.offerCp).toBe(1350);
    expect(result.balanceCp).toBe(250);
    expect(result.accepted).toBe(true);
  });

  it("accepts an exact match — a Trader has no reason to refuse full value", () => {
    const result = barterBalance({
      take: [{ id: "t", valueCp: 1000, qty: 1 }],
      give: [],
      goldCp: 1100,
      multipliers: m
    });
    expect(result.balanceCp).toBe(0);
    expect(result.accepted).toBe(true);
  });

  it("lets coin balance either side", () => {
    const short = barterBalance({
      take: [{ id: "t", valueCp: 1000, qty: 1 }],
      give: [{ id: "g", valueCp: 1000, qty: 1 }],
      goldCp: 650,
      multipliers: m
    });
    expect(short.accepted).toBe(true);

    // Asking for change back on top of an offer that only just covers the ask breaks the deal.
    const greedy = barterBalance({
      take: [{ id: "t", valueCp: 1000, qty: 1 }],
      give: [{ id: "g", valueCp: 1000, qty: 3 }],
      goldCp: -300,
      multipliers: m
    });
    expect(greedy.balanceCp).toBe(-50);
    expect(greedy.accepted).toBe(false);
  });

  it("is no way to dodge a Trader's opinion of you", () => {
    // The same swap is worse at a Trader who dislikes you, exactly as a cash trade would be.
    const swap = attitude => barterBalance({
      take: [{ id: "t", valueCp: 1000, qty: 1 }],
      give: [{ id: "g", valueCp: 1000, qty: 3 }],
      multipliers: priceMultipliers({ chaMod: 0, attitude, anchors: STANDARD })
    }).balanceCp;
    expect(swap(100)).toBeGreaterThan(swap(50));
    expect(swap(50)).toBeGreaterThan(swap(0));
  });
});
