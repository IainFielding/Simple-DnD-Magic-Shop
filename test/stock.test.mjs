import { describe, expect, it } from "vitest";
import {
  MUNDANE, acceptsItem, availableQty, cpToPriceParts, defaultBuyFilter, defaultLine,
  effectiveValueCp, lineVisible, parsePriceInput, rarityToken, sanitizeBuyFilter, sanitizeLine
} from "../scripts/data/stock.mjs";

/** A minimal stand-in for an embedded dnd5e item. Nothing under test calls a method on it. */
const item = ({ type = "weapon", value = 15, denomination = "gp", rarity, quantity = 1 } = {}) => ({
  type,
  system: { price: { value, denomination }, rarity, quantity }
});

describe("sanitizeLine", () => {
  it("fills a missing line with the plain defaults", () => {
    expect(sanitizeLine(undefined)).toEqual(defaultLine());
    expect(sanitizeLine("nonsense")).toEqual(defaultLine());
  });

  it("keeps null for unset override and reveal, never zero", () => {
    // 0 is a *meaningful* revealAt and a catastrophic overrideCp, so "unset" has to be null.
    const line = sanitizeLine({});
    expect(line.overrideCp).toBeNull();
    expect(line.revealAt).toBeNull();
  });

  it("refuses a zero or negative override, which would be a free item", () => {
    expect(sanitizeLine({ overrideCp: 0 }).overrideCp).toBeNull();
    expect(sanitizeLine({ overrideCp: -500 }).overrideCp).toBeNull();
  });

  it("keeps a revealAt of zero, which means visible even to a Trader that loathes you", () => {
    expect(sanitizeLine({ revealAt: 0 }).revealAt).toBe(0);
  });

  it("clamps revealAt into the attitude range", () => {
    expect(sanitizeLine({ revealAt: 500 }).revealAt).toBe(100);
    expect(sanitizeLine({ revealAt: -20 }).revealAt).toBe(0);
  });

  it("never lets baseQty fall below one", () => {
    expect(sanitizeLine({ baseQty: 0 }).baseQty).toBe(1);
    expect(sanitizeLine({ baseQty: -4 }).baseQty).toBe(1);
    expect(sanitizeLine({ baseQty: 12 }).baseQty).toBe(12);
  });
});

describe("lineVisible", () => {
  it("shows an ungated line to anyone", () => {
    expect(lineVisible({}, 0)).toBe(true);
    expect(lineVisible({ revealAt: null }, 0)).toBe(true);
  });

  it("gates a line until the attitude reaches the threshold", () => {
    const gated = { revealAt: 75 };
    expect(lineVisible(gated, 74)).toBe(false);
    expect(lineVisible(gated, 75)).toBe(true);
    expect(lineVisible(gated, 100)).toBe(true);
  });
});

describe("effectiveValueCp", () => {
  it("uses the item's own price when there is no override", () => {
    expect(effectiveValueCp(item({ value: 15, denomination: "gp" }))).toBe(1500);
  });

  it("prefers the GM's override", () => {
    expect(effectiveValueCp(item({ value: 15 }), { overrideCp: 250 })).toBe(250);
  });

  it("reports an unpriced item as zero, which every caller reads as not for sale", () => {
    expect(effectiveValueCp(item({ value: 0 }))).toBe(0);
  });

  it("lets an override price an item the system gives no value", () => {
    expect(effectiveValueCp(item({ value: 0 }), { overrideCp: 5000 })).toBe(5000);
  });
});

describe("availableQty", () => {
  it("counts the item's own quantity", () => {
    expect(availableQty(item({ quantity: 7 }))).toBe(7);
  });

  it("reports Infinity for an unlimited line, so callers need no special case", () => {
    expect(availableQty(item({ quantity: 1 }), { unlimited: true })).toBe(Infinity);
  });

  it("floors a fractional quantity and treats junk as empty", () => {
    expect(availableQty(item({ quantity: 3.8 }))).toBe(3);
    // Built directly rather than through `item()`, whose destructuring default would put the
    // quantity back and never reach the code under test.
    expect(availableQty({ type: "weapon", system: { price: { value: 15 } } })).toBe(0);
    expect(availableQty({ type: "weapon", system: { quantity: "many" } })).toBe(0);
    expect(availableQty(undefined)).toBe(0);
  });
});

describe("rarityToken", () => {
  it("normalises dnd5e's camelCase and older spaced forms alike", () => {
    expect(rarityToken(item({ rarity: "veryRare" }))).toBe("veryrare");
    expect(rarityToken(item({ rarity: "Very Rare" }))).toBe("veryrare");
    expect(rarityToken(item({ rarity: "LEGENDARY" }))).toBe("legendary");
  });

  it("maps gear with no rarity to the explicit mundane token", () => {
    // Without this an absent rarity would fail every rarity filter, and a blacksmith could not
    // buy a plain sword.
    expect(rarityToken(item({ rarity: undefined }))).toBe(MUNDANE);
    expect(rarityToken(item({ rarity: "" }))).toBe(MUNDANE);
    expect(rarityToken(item({ rarity: "homebrew-shiny" }))).toBe(MUNDANE);
  });
});

describe("sanitizeBuyFilter", () => {
  it("defaults to taking anything", () => {
    expect(sanitizeBuyFilter(undefined)).toEqual(defaultBuyFilter());
  });

  it("drops types and rarities the system does not know", () => {
    const filter = sanitizeBuyFilter({
      allowAll: false,
      types: ["weapon", "spell", "class"],
      rarities: ["rare", "ultra", MUNDANE]
    });
    expect(filter.types).toEqual(["weapon"]);
    expect(filter.rarities).toEqual(["rare", MUNDANE]);
  });
});

describe("acceptsItem", () => {
  it("refuses anything that is not physical gear", () => {
    expect(acceptsItem({ type: "spell", system: {} })).toEqual({
      accepted: false, reason: "notPhysical"
    });
  });

  it("refuses an item it cannot put a price on", () => {
    expect(acceptsItem(item({ value: 0 }))).toEqual({ accepted: false, reason: "unpriced" });
  });

  it("takes anything by default", () => {
    expect(acceptsItem(item(), defaultBuyFilter())).toEqual({ accepted: true, reason: null });
  });

  it("honours a type list", () => {
    const smith = { allowAll: false, types: ["weapon", "equipment"], rarities: [] };
    expect(acceptsItem(item({ type: "weapon" }), smith).accepted).toBe(true);
    expect(acceptsItem(item({ type: "consumable" }), smith)).toEqual({
      accepted: false, reason: "wrongType"
    });
  });

  it("honours a rarity list", () => {
    const jeweller = { allowAll: false, types: [], rarities: ["rare", "veryrare", "legendary"] };
    expect(acceptsItem(item({ rarity: "veryRare" }), jeweller).accepted).toBe(true);
    expect(acceptsItem(item({ rarity: "uncommon" }), jeweller)).toEqual({
      accepted: false, reason: "wrongRarity"
    });
  });

  it("expresses 'magic items only' and 'no magic items' with the same mechanism", () => {
    const magicOnly = {
      allowAll: false, types: [],
      rarities: ["uncommon", "rare", "veryrare", "legendary", "artifact"]
    };
    const mundaneOnly = { allowAll: false, types: [], rarities: [MUNDANE, "common"] };
    const plainSword = item({ rarity: undefined });
    const magicSword = item({ rarity: "rare" });

    expect(acceptsItem(plainSword, magicOnly).accepted).toBe(false);
    expect(acceptsItem(magicSword, magicOnly).accepted).toBe(true);
    expect(acceptsItem(plainSword, mundaneOnly).accepted).toBe(true);
    expect(acceptsItem(magicSword, mundaneOnly).accepted).toBe(false);
  });

  it("requires both lists to pass when both are set", () => {
    const filter = { allowAll: false, types: ["weapon"], rarities: ["rare"] };
    expect(acceptsItem(item({ type: "weapon", rarity: "rare" }), filter).accepted).toBe(true);
    expect(acceptsItem(item({ type: "weapon", rarity: "common" }), filter).reason).toBe("wrongRarity");
    expect(acceptsItem(item({ type: "tool", rarity: "rare" }), filter).reason).toBe("wrongType");
  });

  it("ignores the lists entirely when allowAll is set", () => {
    const contradictory = { allowAll: true, types: ["tool"], rarities: ["artifact"] };
    expect(acceptsItem(item({ type: "weapon" }), contradictory).accepted).toBe(true);
  });

  it("always names a reason when it refuses", () => {
    const filter = { allowAll: false, types: ["tool"], rarities: [] };
    for ( const candidate of [{ type: "spell", system: {} }, item({ value: 0 }), item()] ) {
      const result = acceptsItem(candidate, filter);
      if ( !result.accepted ) expect(typeof result.reason).toBe("string");
    }
  });
});

describe("price override inputs", () => {
  it("parses a number and denomination into copper", () => {
    expect(parsePriceInput("15", "gp")).toBe(1500);
    expect(parsePriceInput(3, "sp")).toBe(30);
    expect(parsePriceInput("1", "pp")).toBe(1000);
  });

  it("treats blank, junk and non-positive as no override rather than as free", () => {
    expect(parsePriceInput("", "gp")).toBeNull();
    expect(parsePriceInput("  ", "gp")).toBeNull();
    expect(parsePriceInput("abc", "gp")).toBeNull();
    expect(parsePriceInput("0", "gp")).toBeNull();
    expect(parsePriceInput("-5", "gp")).toBeNull();
    expect(parsePriceInput(undefined, "gp")).toBeNull();
  });

  it("round-trips a stored override back to the denomination the GM typed", () => {
    // Reopening the stock table must not show "15 gp" back as "1500 cp".
    expect(cpToPriceParts(1500)).toEqual({ value: 15, denomination: "gp" });
    expect(cpToPriceParts(30)).toEqual({ value: 3, denomination: "sp" });
    expect(cpToPriceParts(1000)).toEqual({ value: 1, denomination: "pp" });
    expect(cpToPriceParts(7)).toEqual({ value: 7, denomination: "cp" });
  });

  it("falls back to copper for an amount no larger denomination divides", () => {
    expect(cpToPriceParts(157)).toEqual({ value: 157, denomination: "cp" });
    expect(cpToPriceParts(0)).toEqual({ value: 0, denomination: "cp" });
  });

  it("survives a parse-then-format round trip for every clean amount", () => {
    for ( const [value, denomination] of [[15, "gp"], [3, "sp"], [2, "pp"], [9, "cp"]] ) {
      const cp = parsePriceInput(String(value), denomination);
      const parts = cpToPriceParts(cp);
      expect(parsePriceInput(String(parts.value), parts.denomination)).toBe(cp);
    }
  });
});
