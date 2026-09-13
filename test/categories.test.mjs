import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { categoryOptions, categoryTree, countCategories } from "../scripts/app/categories.mjs";

/** A shop line or pool entry: only the two fields categories read. */
const line = (type, subtype = "") => ({ type, subtype });

describe("item categories", () => {
  let saved;
  beforeEach(() => {
    saved = { DND5E: { ...CONFIG.DND5E }, Item: CONFIG.Item };
    // Both of dnd5e's config shapes: plain label strings and `{label}` objects.
    Object.assign(CONFIG.DND5E, {
      weaponTypes: { simpleM: "Simple Melee", martialM: "Martial Melee" },
      equipmentTypes: { heavy: "Heavy Armor", light: "Light Armor" },
      lootTypes: { gem: { label: "Gem" }, art: { label: "Art Object" } },
      consumableTypes: { potion: { label: "Potion" } },
      toolTypes: { music: "Musical Instrument" }
    });
    CONFIG.Item = { typeLabels: { weapon: "Weapon", equipment: "Equipment", loot: "Loot",
      consumable: "Consumable", tool: "Tool", container: "Container" } };
  });
  afterEach(() => {
    CONFIG.DND5E = saved.DND5E;
    CONFIG.Item = saved.Item;
  });

  it("counts every line under its type and its subtype", () => {
    expect(countCategories([line("weapon", "simpleM"), line("weapon", "martialM"), line("loot")]))
      .toEqual({ weapon: 2, "weapon:simpleM": 1, "weapon:martialM": 1, loot: 1 });
  });

  it("builds only the types and subtypes that are present, in dnd5e's type order", () => {
    const tree = categoryTree(countCategories([
      line("loot", "gem"), line("weapon", "simpleM"), line("equipment", "heavy")
    ]));
    expect(tree.map(group => group.value)).toEqual(["weapon", "equipment", "loot"]);
    expect(tree[1].subtypes.map(sub => [sub.value, sub.label])).toEqual([["equipment:heavy", "Heavy Armor"]]);
    expect(tree[2].subtypes[0].label).toBe("Gem");
  });

  it("gives the dropdown All items first, then each type with its subtypes beneath", () => {
    const options = categoryOptions([
      line("weapon", "simpleM"), line("weapon", "simpleM"), line("equipment", "heavy")
    ], "weapon:simpleM");
    expect(options.map(o => [o.value, o.count, o.sub])).toEqual([
      ["", 3, false],
      ["weapon", 2, false],
      ["weapon:simpleM", 2, true],
      ["equipment", 1, false],
      ["equipment:heavy", 1, true]
    ]);
    expect(options.filter(o => o.selected).map(o => o.value)).toEqual(["weapon:simpleM"]);
  });

  it("never offers a category the panel does not hold", () => {
    const values = categoryOptions([line("loot", "gem")]).map(o => o.value);
    expect(values).not.toContain("weapon");
    expect(values).not.toContain("loot:art");
  });

  it("offers nothing for an empty panel, so the dropdown is not drawn", () => {
    expect(categoryOptions([])).toEqual([]);
  });

  it("keeps a homebrew subtype findable under its type", () => {
    const options = categoryOptions([line("loot", "homebrewThing")]);
    expect(options.map(o => o.value)).toEqual(["", "loot"]);
  });
});
