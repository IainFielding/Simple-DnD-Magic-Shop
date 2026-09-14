import { describe, expect, it } from "vitest";
import { descendantFolderIds, sortDropped } from "../scripts/data/folder-drop.mjs";

describe("descendantFolderIds", () => {
  it("takes in every folder below, however deep, and nothing beside it", () => {
    const folders = [
      // Listed child-first, so a single pass would miss the grandchild.
      { id: "dagger", parent: "blades" },
      { id: "blades", parent: "weapons" },
      { id: "weapons", parent: null },
      { id: "armor", parent: null },
      { id: "shields", parent: "armor" }
    ];
    expect([...descendantFolderIds("weapons", folders)].sort()).toEqual(["blades", "dagger", "weapons"]);
    expect([...descendantFolderIds("dagger", folders)]).toEqual(["dagger"]);
  });
});

describe("sortDropped", () => {
  const hollow = () => ({
    name: "Weapon, +1, +2, or +3", type: "weapon",
    system: {
      price: { value: 0, denomination: "gp" }, properties: ["mgc"], type: { value: "" },
      activities: { a: { _id: "a", type: "enchant", effects: [{ _id: "e1" }], restrictions: {} } }
    },
    effects: [{ _id: "e1", name: "Weapon +1", type: "enchantment", system: { changes: [] } }]
  });

  it("sorts gear, spells, templates and everything else apart", () => {
    const sorted = sortDropped([
      { name: "Longsword", type: "weapon", system: {} },
      { name: "Fireball", type: "spell", system: {} },
      hollow(),
      { name: "Rage", type: "feat", system: {} }
    ]);
    expect(sorted.plain.map(i => i.name)).toEqual(["Longsword"]);
    expect(sorted.spells.map(i => i.name)).toEqual(["Fireball"]);
    expect(sorted.templates.map(i => i.name)).toEqual(["Weapon, +1, +2, or +3"]);
    expect(sorted.skipped.map(i => i.name)).toEqual(["Rage"]);
  });

  it("leaves out what is packed inside a container", () => {
    const sorted = sortDropped([
      { name: "Explorer's Pack", type: "container", system: {} },
      { name: "Bedroll", type: "equipment", system: { container: "pack1" } }
    ]);
    expect(sorted.plain.map(i => i.name)).toEqual(["Explorer's Pack"]);
    expect(sorted.skipped).toEqual([]);
  });
});
