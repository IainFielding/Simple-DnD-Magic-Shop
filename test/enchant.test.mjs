import { describe, expect, it } from "vitest";
import {
  baseTypeFor, eligibleBases, enchantProfiles, enchantedItemData, enchantedValueCp, isHollowTemplate,
  madeIdentity, mightBeTemplate, pickBase, rarityValueCp, templateEntries
} from "../scripts/data/enchant.mjs";
import { categoryTokens } from "../scripts/data/generate.mjs";

const MODULE = "sogrom-simple-dnd5e-magic-shop";

/*
 * Fixtures shaped like the Dungeon Master's Guide 2024 pack's real data, as `toObject()` returns it:
 * activities keyed by id, effects as an array, enchantment changes under `system.changes`.
 */

const change = (key, value, type = "override") => ({ key, value, type });
const profile = (id, riders = {}) => ({
  _id: id, level: { min: null, max: null },
  riders: { activity: riders.activity ?? [], effect: riders.effect ?? [], item: riders.item ?? [] }
});

/** "Weapon, +1, +2, or +3": no base, no price, three priced profiles. */
const weaponPlus = () => ({
  name: "Weapon, +1, +2, or +3",
  type: "weapon",
  img: "plus.webp",
  system: {
    rarity: "",
    price: { value: 0, denomination: "gp" },
    properties: ["mgc"],
    type: { value: "", baseItem: "" },
    activities: {
      act1: {
        _id: "act1", type: "enchant",
        effects: [profile("p1"), profile("p2"), profile("p3")],
        restrictions: { type: "", categories: [], properties: [], allowMagical: false }
      }
    }
  },
  effects: [1, 2, 3].map(n => ({
    _id: `p${n}`, name: `Weapon +${n}`, type: "enchantment", transfer: true,
    system: { changes: [
      change("name", `{} +${n}`),
      change("system.magicalBonus", n, "upgrade"),
      change("system.rarity", ["uncommon", "rare", "veryRare"][n - 1]),
      change("system.properties", "mgc", "add"),
      change("system.price.value", [400, 4000, 40000][n - 1], "add"),
      change("system.price.denomination", "gp")
    ] }
  }))
});

/** Flame Tongue: a second enchant activity that is a rider of the first. */
const flameTongue = () => ({
  name: "Flame Tongue",
  type: "weapon",
  img: "flame.webp",
  system: {
    rarity: "rare",
    price: { value: 4000, denomination: "gp" },
    properties: ["mgc"],
    type: { value: "" },
    activities: {
      make: {
        _id: "make", type: "enchant", effects: [profile("ft", { activity: ["ablaze"] })],
        restrictions: { type: "", categories: [], properties: [], allowMagical: false }
      },
      ablaze: {
        _id: "ablaze", type: "enchant", effects: [profile("fire")],
        restrictions: { type: "weapon", categories: ["simpleM", "martialM"], properties: [], allowMagical: true }
      }
    }
  },
  effects: [
    { _id: "ft", name: "Flame Tongue", type: "enchantment", transfer: true, system: { changes: [
      change("name", "Flame Tongue {}"), change("system.price.value", 4000, "add")
    ] } },
    { _id: "fire", name: "Ablaze", type: "enchantment", transfer: true, system: { changes: [
      change("name", "{} (Ablaze)")
    ] } }
  ]
});

/** Armor of Resistance: rider effects carry the actual resistance. */
const armorOfResistance = () => ({
  name: "Armor of Resistance",
  type: "equipment",
  system: {
    rarity: "rare", price: { value: 4000, denomination: "gp" }, properties: ["mgc"], type: { value: "" },
    activities: {
      res: {
        _id: "res", type: "enchant", effects: [profile("fireArmor", { effect: ["fireRes"] })],
        restrictions: { type: "equipment", categories: ["light", "medium", "heavy"], properties: [], allowMagical: false }
      }
    }
  },
  effects: [
    { _id: "fireArmor", name: "Armor of Fire Resistance", type: "enchantment", transfer: true, system: { changes: [
      change("system.rarity", "rare"), change("system.price.value", 4000, "add")
    ] } },
    { _id: "fireRes", name: "Fire Resistance", type: "base", transfer: true, flags: { dnd5e: { rider: true } },
      system: { changes: [change("system.traits.dr.value", "fire", "add")] } }
  ]
});

/** Ammunition +1: a rarity but no price of its own. */
const ammoPlus = () => ({
  name: "Ammunition, +1, +2, or +3",
  type: "consumable",
  system: {
    rarity: "", price: { value: 0, denomination: "gp" }, properties: ["mgc"], type: { value: "ammo" },
    activities: {
      a: { _id: "a", type: "enchant", effects: [profile("am1")],
        restrictions: { type: "", categories: [], properties: [], allowMagical: false } }
    }
  },
  effects: [{ _id: "am1", name: "Ammunition +1", type: "enchantment", transfer: true,
    system: { changes: [change("system.rarity", "uncommon")] } }]
});

const bases = [
  { uuid: "B.longsword", name: "Longsword", type: "weapon", subtype: "martialM", properties: [], valueCp: 1500 },
  { uuid: "B.dagger", name: "Dagger", type: "weapon", subtype: "simpleM", properties: ["fin"], valueCp: 200 },
  { uuid: "B.longbow", name: "Longbow", type: "weapon", subtype: "martialR", properties: [], valueCp: 5000 },
  { uuid: "B.plate", name: "Plate Armor", type: "equipment", subtype: "heavy", properties: [], valueCp: 150000 },
  { uuid: "B.shield", name: "Shield", type: "equipment", subtype: "shield", properties: [], valueCp: 1000 },
  { uuid: "B.arrows", name: "Arrows", type: "consumable", subtype: "ammo", properties: [], valueCp: 100 },
  { uuid: "B.magic", name: "Sun Blade", type: "weapon", subtype: "martialM", properties: ["mgc"], valueCp: 1 }
];

describe("enchantProfiles", () => {
  it("reads each profile's name, rarity and price", () => {
    const profiles = enchantProfiles(weaponPlus());
    expect(profiles.map(p => p.name)).toEqual(["Weapon +1", "Weapon +2", "Weapon +3"]);
    expect(profiles.map(p => p.rarity)).toEqual(["uncommon", "rare", "veryrare"]);
    expect(profiles[0].priceAdd).toEqual({ value: 400, denomination: "gp" });
    expect(profiles[0].key).toBe("act1.p1");
  });

  it("skips a rider activity, which toggles a finished item rather than making one", () => {
    const profiles = enchantProfiles(flameTongue());
    expect(profiles.map(p => p.name)).toEqual(["Flame Tongue"]);
    expect(profiles[0].riders.activity).toEqual(["ablaze"]);
    // No rarity change of its own: the template's rarity stands.
    expect(profiles[0].rarity).toBe("rare");
  });

  it("skips profiles that grant items", () => {
    const t = weaponPlus();
    t.system.activities.act1.effects[0].riders.item = ["Compendium.x.y.Item.z"];
    expect(enchantProfiles(t).map(p => p.name)).toEqual(["Weapon +2", "Weapon +3"]);
  });

  it("reads Sets as dnd5e documents hold them", () => {
    const t = weaponPlus();
    t.system.activities.act1.restrictions.categories = new Set(["simpleM"]);
    expect(enchantProfiles(t)[0].restrictions.categories).toEqual(["simpleM"]);
  });

  it("is empty for an ordinary item", () => {
    expect(enchantProfiles({ type: "weapon", system: { activities: {} }, effects: [] })).toEqual([]);
  });
});

describe("isHollowTemplate", () => {
  it("recognises templates with no subtype or no price", () => {
    expect(isHollowTemplate(weaponPlus())).toBe(true);
    expect(isHollowTemplate(flameTongue())).toBe(true);
    expect(isHollowTemplate(ammoPlus())).toBe(true);
  });

  it("leaves a whole item that happens to carry an enchant activity alone", () => {
    const axe = flameTongue();
    axe.system.type.value = "martialM";
    expect(isHollowTemplate(axe)).toBe(false);
  });

  it("is false for anything not magical", () => {
    const t = weaponPlus();
    t.system.properties = [];
    expect(isHollowTemplate(t)).toBe(false);
  });
});

describe("eligibleBases", () => {
  it("follows the template's own type when the enchantment names none", () => {
    const [plusOne] = enchantProfiles(weaponPlus());
    const type = baseTypeFor(plusOne, weaponPlus());
    expect(type).toBe("weapon");
    expect(eligibleBases(plusOne, type, bases).map(b => b.name)).toEqual(["Longsword", "Dagger", "Longbow"]);
  });

  it("honours categories, and never enchants a magic item unless allowed", () => {
    const [fire] = enchantProfiles(armorOfResistance());
    expect(eligibleBases(fire, "equipment", bases).map(b => b.name)).toEqual(["Plate Armor"]);
  });

  it("honours required properties", () => {
    const [plusOne] = enchantProfiles(weaponPlus());
    plusOne.restrictions.properties = ["fin"];
    expect(eligibleBases(plusOne, "weapon", bases).map(b => b.name)).toEqual(["Dagger"]);
  });
});

describe("values", () => {
  it("prices from the enchantment's own price, on top of the base", () => {
    const [plusOne] = enchantProfiles(weaponPlus());
    expect(enchantedValueCp({ baseValueCp: 1500, profile: plusOne })).toBe(1500 + 40_000);
  });

  it("falls back to the DMG rarity price, halved for a consumable", () => {
    const [ammo] = enchantProfiles(ammoPlus());
    expect(enchantedValueCp({ baseValueCp: 100, profile: ammo, consumable: true })).toBe(100 + 20_000);
    expect(rarityValueCp("artifact")).toBe(0);
  });
});

describe("enchantedItemData", () => {
  let n = 0;
  const newId = () => `id${++n}`;
  const base = {
    _id: "baseId", name: "Plate Armor", type: "equipment", folder: "f", sort: 5,
    system: { price: { value: 1500, denomination: "gp" }, activities: {}, quantity: 1 },
    effects: [], flags: {}
  };

  it("embeds the enchantment as dnd5e applies it, with its riders", () => {
    n = 0;
    const template = armorOfResistance();
    const [fire] = enchantProfiles(template);
    const data = enchantedItemData({
      base, baseUuid: "B.plate", template, templateUuid: "T.res", profile: fire, newId
    });
    expect(data._id).toBeUndefined();
    expect(data.folder).toBeUndefined();
    const [enchantment, rider] = data.effects;
    expect(enchantment).toMatchObject({
      _id: "id1", name: "Armor of Fire Resistance", transfer: true, disabled: false,
      flags: { dnd5e: { enchantmentProfile: "fireArmor" } },
      system: { origin: { activity: "T.res.Activity.res", profile: "fireArmor" } }
    });
    // Left unset on purpose: dnd5e would otherwise re-check the restrictions against an item that is
    // now magical, and refuse the effect on the buyer's copy.
    expect(enchantment.origin).toBeUndefined();
    expect(rider).toMatchObject({ _id: "id2", name: "Fire Resistance", flags: { dnd5e: { dependentOn: "id1" } } });
    expect(rider.flags.dnd5e.rider).toBeUndefined();
    expect(data._stats.compendiumSource).toBe("B.plate");
    expect(data.flags[MODULE].madeFrom).toEqual({ template: "T.res", profile: "res.fireArmor", base: "B.plate" });
  });

  it("copies a rider activity, keeping the ids of the effects it points at", () => {
    n = 0;
    const template = flameTongue();
    const [ft] = enchantProfiles(template);
    const data = enchantedItemData({
      base: { ...base, type: "weapon" }, baseUuid: "B.longsword", template, templateUuid: "T.ft", profile: ft, newId
    });
    const activities = Object.values(data.system.activities);
    expect(activities).toHaveLength(1);
    expect(activities[0].flags.dnd5e.dependentOn).toBe("id1");
    expect(data.effects.map(e => e._id)).toEqual(["id1", "fire"]);
  });

  it("leaves a priced enchantment's price to dnd5e, and folds in the rarity price otherwise", () => {
    const [plusOne] = enchantProfiles(weaponPlus());
    const priced = enchantedItemData({ base, baseUuid: "B", template: weaponPlus(), templateUuid: "T", profile: plusOne, newId });
    expect(priced.system.price).toEqual({ value: 1500, denomination: "gp" });

    const [ammo] = enchantProfiles(ammoPlus());
    const arrows = { ...base, type: "consumable", system: { ...base.system, price: { value: 1, denomination: "gp" } } };
    const unpriced = enchantedItemData({ base: arrows, baseUuid: "B", template: ammoPlus(), templateUuid: "T", profile: ammo, newId });
    expect(unpriced.system.price).toEqual({ value: 201, denomination: "gp" });
  });

  it("does not modify the data it was given", () => {
    const template = weaponPlus();
    const before = JSON.stringify({ base, template });
    enchantedItemData({ base, baseUuid: "B", template, templateUuid: "T", profile: enchantProfiles(template)[0], newId });
    expect(JSON.stringify({ base, template })).toBe(before);
  });
});

describe("madeIdentity", () => {
  it("tells a Longsword +1 from a Flame Tongue Longsword", () => {
    const plus = madeIdentity({ template: "T.plus", profile: "a.p1", base: "B.longsword" });
    const flame = madeIdentity({ template: "T.ft", profile: "make.ft", base: "B.longsword" });
    expect(plus).not.toBe(flame);
    expect(madeIdentity({ spell: "S.fireball" })).toBe("scroll:S.fireball");
    expect(madeIdentity(null)).toBe("");
  });
});

describe("templateEntries", () => {
  it("contributes one pool entry per enchantment with a base, priced from the cheapest base", () => {
    const entries = templateEntries({ template: weaponPlus(), uuid: "T.plus", bases });
    expect(entries.map(e => e.rarity)).toEqual(["uncommon", "rare", "veryrare"]);
    expect(entries[0]).toMatchObject({ kind: "enchant", type: "weapon", profileKey: "act1.p1", valueCp: 200 + 40_000 });
    expect(entries[0].subtypes.sort()).toEqual(["martialM", "martialR", "simpleM"]);
  });

  it("answers to every subtype it could become", () => {
    const [entry] = templateEntries({ template: armorOfResistance(), uuid: "T.res", bases });
    expect(categoryTokens(entry)).toEqual(["equipment", "equipment:heavy"]);
  });

  it("contributes nothing when no base fits", () => {
    expect(templateEntries({ template: weaponPlus(), uuid: "T", bases: [] })).toEqual([]);
  });
});

describe("pickBase", () => {
  const eligible = bases.slice(0, 3);

  it("keeps within the recipe's kinds and price ceiling", () => {
    expect(pickBase({ eligible, categories: ["weapon:simpleM"], rng: () => 0 }).name).toBe("Dagger");
    expect(pickBase({ eligible, maxValueCp: 1000, enchantCp: 500, rng: () => 0 }).name).toBe("Dagger");
  });

  it("is null when nothing fits", () => {
    expect(pickBase({ eligible, maxValueCp: 100, enchantCp: 40_000 })).toBe(null);
  });
});

describe("mightBeTemplate", () => {
  it("picks magical entries missing a subtype or a price, and nothing else", () => {
    expect(mightBeTemplate({ type: "weapon", subtype: "", valueCp: 400, properties: ["mgc"] })).toBe(true);
    expect(mightBeTemplate({ type: "consumable", subtype: "ammo", valueCp: 0, properties: ["mgc"] })).toBe(true);
    expect(mightBeTemplate({ type: "weapon", subtype: "martialM", valueCp: 400, properties: ["mgc"] })).toBe(false);
    expect(mightBeTemplate({ type: "weapon", subtype: "", valueCp: 0, properties: [] })).toBe(false);
    expect(mightBeTemplate({ type: "loot", subtype: "", valueCp: 0, properties: ["mgc"] })).toBe(false);
  });
});
