import { describe, expect, it } from "vitest";
import {
  BUDGET_KEYS, bucketByRarity, budgetTotal, categoryCounts, categoryTokens, defaultBudget,
  filterPool, matchesCategories, pickByBudget, rollTableStock, sanitizeBudget, seededRng
} from "../scripts/data/generate.mjs";

/** A pool entry, as `data/item-index.mjs` shapes them. */
const entry = (uuid, rarity = "", valueCp = 1500, extra = {}) => ({
  uuid, name: uuid, img: "x.webp", type: "weapon", subtype: "", rarity, valueCp,
  pack: "dnd5e.items", packLabel: "Items", ...extra
});

/** `n` entries of one rarity, uniquely named. */
const many = (rarity, n, valueCp = 1500) =>
  Array.from({ length: n }, (_, i) => entry(`${rarity || "mundane"}-${i}`, rarity, valueCp));

describe("sanitizeBudget", () => {
  it("fills every bucket, so callers need no optional chaining", () => {
    const budget = sanitizeBudget({});
    expect(Object.keys(budget).sort()).toEqual([...BUDGET_KEYS].sort());
    expect(Object.values(budget).every(n => n === 0)).toBe(true);
  });

  it("discards negative and junk counts", () => {
    const budget = sanitizeBudget({ rare: -3, common: "lots", uncommon: 2.6 });
    expect(budget.rare).toBe(0);
    expect(budget.common).toBe(0);
    expect(budget.uncommon).toBe(3);
  });

  it("caps a bucket, so a mistyped 1000 cannot hang the client", () => {
    expect(sanitizeBudget({ common: 100_000 }).common).toBe(200);
  });

  it("ignores buckets it does not know", () => {
    expect(sanitizeBudget({ mythic: 5 }).mythic).toBeUndefined();
  });

  it("totals what a budget asks for", () => {
    expect(budgetTotal(defaultBudget())).toBe(30);
    expect(budgetTotal({})).toBe(0);
  });
});

describe("filterPool", () => {
  const pool = [
    entry("cheap", "common", 500),
    entry("mid", "rare", 50_000),
    entry("dear", "legendary", 2_000_000),
    entry("free", "common", 0),
    entry("other-pack", "common", 1000, { pack: "phb.items" }),
    entry("a-tool", "common", 1000, { type: "tool" })
  ];

  it("always drops unpriced items — a shop cannot sell what has no value", () => {
    expect(filterPool(pool).map(e => e.uuid)).not.toContain("free");
  });

  it("honours a price ceiling, so one click cannot hand over a 20,000 gp staff", () => {
    const capped = filterPool(pool, { maxValueCp: 100_000 }).map(e => e.uuid);
    expect(capped).toContain("mid");
    expect(capped).not.toContain("dear");
  });

  it("honours a price floor", () => {
    expect(filterPool(pool, { minValueCp: 1000 }).map(e => e.uuid)).not.toContain("cheap");
  });

  it("restricts to chosen packs", () => {
    expect(filterPool(pool, { packs: ["phb.items"] }).map(e => e.uuid)).toEqual(["other-pack"]);
  });

  it("restricts to a chosen item type", () => {
    expect(filterPool(pool, { categories: ["tool"] }).map(e => e.uuid)).toEqual(["a-tool"]);
  });

  it("treats empty lists as no restriction", () => {
    expect(filterPool(pool, { packs: [], categories: [] })).toHaveLength(5);
  });

  it("survives a missing pool", () => {
    expect(filterPool(undefined)).toEqual([]);
  });
});

describe("categories", () => {
  /**
   * The pool a GM actually faces: dnd5e has six physical item types, and neither "armour" nor
   * "musical instrument" is among them. Armour is `equipment` with a subtype, a lute is a `tool`
   * with a subtype of `music` — which is the whole reason categories have two levels.
   */
  const pool = [
    entry("longsword", "", 1500, { type: "weapon", subtype: "martialM" }),
    entry("dagger", "", 200, { type: "weapon", subtype: "simpleM" }),
    entry("plate", "", 150_000, { type: "equipment", subtype: "heavy" }),
    entry("leather", "", 1000, { type: "equipment", subtype: "light" }),
    entry("lute", "", 3500, { type: "tool", subtype: "music" }),
    entry("dice-set", "", 100, { type: "tool", subtype: "game" }),
    entry("gem", "", 5000, { type: "loot", subtype: "gem" }),
    entry("plain", "", 500, { type: "loot", subtype: "" })
  ];

  it("gives an item both a type token and a type-and-subtype token", () => {
    expect(categoryTokens(pool[0])).toEqual(["weapon", "weapon:martialM"]);
  });

  it("gives a subtype-less item only its type token", () => {
    expect(categoryTokens(pool[7])).toEqual(["loot"]);
  });

  it("matches everything when nothing is chosen", () => {
    expect(pool.every(e => matchesCategories(e, []))).toBe(true);
  });

  it("lets a whole type be chosen, taking every subtype of it", () => {
    const picked = filterPool(pool, { categories: ["weapon"] }).map(e => e.uuid);
    expect(picked.sort()).toEqual(["dagger", "longsword"]);
  });

  it("lets armour be asked for, which is not an item type at all", () => {
    const picked = filterPool(pool, { categories: ["equipment:heavy", "equipment:light"] })
      .map(e => e.uuid);
    expect(picked.sort()).toEqual(["leather", "plate"]);
  });

  it("lets musical instruments be asked for without the gaming sets", () => {
    expect(filterPool(pool, { categories: ["tool:music"] }).map(e => e.uuid)).toEqual(["lute"]);
  });

  it("mixes whole types and single subtypes freely", () => {
    const picked = filterPool(pool, { categories: ["loot", "tool:music"] }).map(e => e.uuid);
    expect(picked.sort()).toEqual(["gem", "lute", "plain"]);
  });

  it("counts an item under both of its tokens, so a heading is a superset", () => {
    const counts = categoryCounts(pool);
    expect(counts.weapon).toBe(2);
    expect(counts["weapon:martialM"]).toBe(1);
    expect(counts.tool).toBe(2);
    expect(counts["tool:music"]).toBe(1);
  });

  it("does not count unpriced items, which can never be generated", () => {
    const counts = categoryCounts([...pool, entry("worthless", "", 0, { type: "loot" })]);
    expect(counts.loot).toBe(2);
  });

  it("combines with the price ceiling rather than replacing it", () => {
    const picked = filterPool(pool, {
      categories: ["equipment"], maxValueCp: 50_000
    }).map(e => e.uuid);
    expect(picked).toEqual(["leather"]);
  });
});

describe("bucketByRarity", () => {
  it("groups by rarity and keeps every bucket present", () => {
    const buckets = bucketByRarity([entry("a", "rare"), entry("b", "rare"), entry("c", "")]);
    expect(buckets.get("rare")).toHaveLength(2);
    expect(buckets.get("")).toHaveLength(1);
    expect(buckets.get("artifact")).toEqual([]);
  });

  it("files an unknown rarity with mundane gear rather than dropping it", () => {
    // The GM put it in a pack, so it is presumably meant to be sellable.
    const buckets = bucketByRarity([entry("weird", "mythic")]);
    expect(buckets.get("")).toHaveLength(1);
  });
});

describe("pickByBudget", () => {
  it("draws the number asked for from each bucket", () => {
    const pool = [...many("", 30), ...many("uncommon", 10), ...many("rare", 5)];
    const { picked, shortfalls } = pickByBudget({
      pool, budget: { "": 20, uncommon: 3, rare: 1 }, rng: seededRng(1)
    });
    expect(picked).toHaveLength(24);
    expect(picked.filter(e => e.rarity === "").length).toBe(20);
    expect(picked.filter(e => e.rarity === "uncommon").length).toBe(3);
    expect(picked.filter(e => e.rarity === "rare").length).toBe(1);
    expect(shortfalls).toEqual({});
  });

  it("never repeats an item — six uncommon means six different ones", () => {
    const pool = many("uncommon", 20);
    const { picked } = pickByBudget({ pool, budget: { uncommon: 6 }, rng: seededRng(7) });
    expect(new Set(picked.map(e => e.uuid)).size).toBe(6);
  });

  it("reports a shortfall rather than silently handing back fewer", () => {
    // Otherwise a GM whose packs hold two legendary items concludes the generator is broken.
    const pool = many("legendary", 2);
    const { picked, shortfalls } = pickByBudget({
      pool, budget: { legendary: 5 }, rng: seededRng(3)
    });
    expect(picked).toHaveLength(2);
    expect(shortfalls).toEqual({ legendary: 3 });
  });

  it("reports a shortfall for an empty bucket", () => {
    const { picked, shortfalls } = pickByBudget({
      pool: many("common", 5), budget: { artifact: 2 }, rng: seededRng(3)
    });
    expect(picked).toEqual([]);
    expect(shortfalls).toEqual({ artifact: 2 });
  });

  it("can drain a bucket exactly without rerolling itself to death", () => {
    const pool = many("rare", 20);
    const { picked, shortfalls } = pickByBudget({ pool, budget: { rare: 20 }, rng: seededRng(11) });
    expect(picked).toHaveLength(20);
    expect(new Set(picked.map(e => e.uuid)).size).toBe(20);
    expect(shortfalls).toEqual({});
  });

  it("is reproducible for a given seed", () => {
    const pool = many("uncommon", 40);
    const run = () => pickByBudget({ pool, budget: { uncommon: 8 }, rng: seededRng(42) })
      .picked.map(e => e.uuid);
    expect(run()).toEqual(run());
  });

  it("gives different results for different seeds", () => {
    const pool = many("uncommon", 40);
    const run = seed => pickByBudget({ pool, budget: { uncommon: 8 }, rng: seededRng(seed) })
      .picked.map(e => e.uuid);
    expect(run(1)).not.toEqual(run(2));
  });

  it("does nothing for an empty budget", () => {
    const { picked } = pickByBudget({ pool: many("common", 10), budget: {}, rng: seededRng(1) });
    expect(picked).toEqual([]);
  });

  it("survives an empty pool", () => {
    const { picked, shortfalls } = pickByBudget({
      pool: [], budget: defaultBudget(), rng: seededRng(1)
    });
    expect(picked).toEqual([]);
    expect(shortfalls[""]).toBe(20);
  });
});

describe("seededRng", () => {
  it("stays inside [0, 1)", () => {
    const rng = seededRng(99);
    for ( let i = 0; i < 1000; i++ ) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("does not get stuck on one value", () => {
    const rng = seededRng(5);
    const seen = new Set(Array.from({ length: 50 }, () => rng()));
    expect(seen.size).toBeGreaterThan(40);
  });
});

describe("rollTableStock", () => {
  /** A table stand-in that hands out `outcomes` in order, one roll at a time. */
  const table = outcomes => {
    let n = 0;
    return {
      rolls: () => n,
      roll: async () => ({ results: outcomes[n++] ?? [] })
    };
  };
  const item = uuid => ({ documentUuid: uuid });

  it("rolls once per draw, not once in total", async () => {
    const t = table([[item("a")], [item("b")], [item("c")], [item("d")]]);
    expect(await rollTableStock(t, 3)).toEqual(["a", "b", "c"]);
    expect(t.rolls()).toBe(3);
  });

  it("skips text results and keeps every item a nested roll yields", async () => {
    const t = table([[{ text: "50 gp" }], [item("a"), item("b")]]);
    expect(await rollTableStock(t, 2)).toEqual(["a", "b"]);
  });

  it("stops when a table without replacement runs dry", async () => {
    const t = table([[item("a")]]);
    expect(await rollTableStock(t, 10)).toEqual(["a"]);
    expect(t.rolls()).toBe(2);
  });

  it("reads the older collection-and-id result shape", async () => {
    const t = table([[{ documentCollection: "dnd5e.items", documentId: "abc" }]]);
    expect(await rollTableStock(t, 1)).toEqual(["Compendium.dnd5e.items.Item.abc"]);
  });

  it("returns nothing for something that is not a table", async () => {
    expect(await rollTableStock(null, 3)).toEqual([]);
  });
});
