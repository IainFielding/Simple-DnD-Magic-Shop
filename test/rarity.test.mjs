import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemRarity, normalizeRarity } from "../scripts/config.mjs";
import { enchantProfiles } from "../scripts/data/enchant.mjs";
import { clearIndexCache, itemPool } from "../scripts/data/item-index.mjs";
import { exportItem } from "../scripts/data/portable.mjs";
import { rarityToken } from "../scripts/data/stock.mjs";

/*
 * dnd5e 6.0.2 replaced `system.rarity` with a `system.rarities` set. A live document still answers
 * `rarity` through a getter, but its data and a migrated compendium index carry only `rarities` —
 * which left the generator reading every item in the world as mundane.
 */

describe("itemRarity", () => {
  it("reads the old single field, in either spelling", () => {
    expect(itemRarity({ system: { rarity: "veryRare" } })).toBe("veryrare");
    expect(itemRarity({ system: { rarity: "Very Rare" } })).toBe("veryrare");
  });

  it("reads the first of the new set, as an array, a Set or a lone string", () => {
    expect(itemRarity({ system: { rarities: ["uncommon", "rare"] } })).toBe("uncommon");
    expect(itemRarity({ system: { rarities: new Set(["legendary"]) } })).toBe("legendary");
    expect(itemRarity({ system: { rarities: "rare" } })).toBe("rare");
  });

  it("prefers the single field when a document carries both", () => {
    expect(itemRarity({ system: { rarity: "rare", rarities: ["common"] } })).toBe("rare");
  });

  it("is empty for mundane gear, an empty set and a homebrew rarity", () => {
    expect(itemRarity({ system: {} })).toBe("");
    expect(itemRarity({ system: { rarities: [] } })).toBe("");
    expect(itemRarity({ system: { rarities: ["mythic"] } })).toBe("");
    expect(itemRarity(null)).toBe("");
  });

  it("agrees with normalizeRarity on every key", () => {
    for ( const key of ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"] ) {
      expect(itemRarity({ system: { rarities: [key] } })).toBe(normalizeRarity(key));
    }
  });
});

describe("the buy filter's rarity token", () => {
  it("reads the new set", () => {
    expect(rarityToken({ system: { rarities: ["rare"] } })).toBe("rare");
    expect(rarityToken({ system: { rarities: [] } })).toBe("mundane");
  });
});

describe("the generator's item pool", () => {
  let asked = null;

  beforeEach(() => {
    clearIndexCache();
    globalThis.Item = class Item {};
    game.packs = { get: () => ({ title: "Test Items" }) };
    globalThis.dnd5e = {
      applications: {
        CompendiumBrowser: {
          fetch: async (_cls, options) => {
            asked = options;
            return [
              { uuid: "Compendium.m.items.Item.a", name: "Cloak", type: "equipment",
                system: { rarities: ["uncommon"], type: { value: "wondrous" }, armor: { value: 0 } } },
              { uuid: "Compendium.m.items.Item.b", name: "Rope", type: "loot", system: { rarities: [] } },
              { uuid: "Compendium.m.items.Item.c", name: "Old Wand", type: "loot", system: { rarity: "rare" } },
              { uuid: "Compendium.m.items.Item.d", name: "Bonfire Blade", type: "weapon",
                system: { rarities: ["common"], type: { value: "martialM", baseItem: "" }, damage: { base: {} } } }
            ];
          }
        }
      }
    };
  });

  afterEach(() => {
    clearIndexCache();
    delete game.packs;
    delete globalThis.dnd5e;
    delete globalThis.Item;
  });

  it("asks the index for both rarity shapes and reads whichever arrived", async () => {
    const pool = await itemPool();
    expect([...asked.indexFields]).toEqual(expect.arrayContaining(["system.rarity", "system.rarities"]));
    expect(pool.map(e => [e.name, e.rarity])).toEqual([
      ["Cloak", "uncommon"], ["Rope", ""], ["Old Wand", "rare"], ["Bonfire Blade", "common"]
    ]);
  });

  it("marks the entries that might be shells, so only those are loaded to tell", async () => {
    const pool = await itemPool();
    expect(pool.filter(e => e.shellCandidate).map(e => e.name)).toEqual(["Bonfire Blade"]);
  });
});

describe("enchantments that set a rarity", () => {
  const template = changes => ({
    name: "Weapon, +1, +2, or +3",
    type: "weapon",
    system: {
      rarities: [],
      properties: ["mgc"],
      type: { value: "" },
      activities: {
        a: { _id: "a", type: "enchant", effects: [{ _id: "p", riders: {} }], restrictions: {} }
      }
    },
    effects: [{ _id: "p", name: "Weapon +1", type: "enchantment", system: { changes } }]
  });

  it("read a change migrated to the new set, however its value is written", () => {
    for ( const value of ["uncommon", ["uncommon"], "[\"uncommon\"]", "uncommon,rare"] ) {
      const changes = [{ key: "system.rarities", value, type: "add" }];
      expect(enchantProfiles(template(changes))[0].rarity).toBe("uncommon");
    }
  });

  it("still read the old key", () => {
    const changes = [{ key: "system.rarity", value: "veryRare", type: "override" }];
    expect(enchantProfiles(template(changes))[0].rarity).toBe("veryrare");
  });

  it("fall back on the template's own set when they set none", () => {
    const t = template([]);
    t.system.rarities = ["rare"];
    expect(enchantProfiles(t)[0].rarity).toBe("rare");
  });

  it("fall back on the template's headline when it has no rarity field at all", () => {
    const t = template([]);
    t.system.description = { value: "<p><em>Weapon (Any Sword), Very Rare</em></p><p>Prose.</p>" };
    expect(enchantProfiles(t)[0].rarity).toBe("veryrare");
  });
});

describe("exporting a made item", () => {
  it("keeps who may attune to it", () => {
    const out = exportItem({
      type: "weapon",
      flags: { "sogrom-simple-dnd5e-magic-shop": { madeFrom: { template: "T", profile: "a.p", base: "B", attunement: "a Paladin" } } }
    });
    expect(out.flags["sogrom-simple-dnd5e-magic-shop"].madeFrom.attunement).toBe("a Paladin");
  });
});
