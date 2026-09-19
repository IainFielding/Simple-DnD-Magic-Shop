import { describe, expect, it } from "vitest";
import { enchantedItemData, enchantProfiles } from "../scripts/data/enchant.mjs";
import {
  attunementFor, attunementRestriction, itemUsability, proficiencyMaps, unmetAttunement, usabilityFields,
  usabilityNotes, usabilityProfile
} from "../scripts/data/usability.mjs";

const MODULE = "sogrom-simple-dnd5e-magic-shop";

/** dnd5e 6.0.3's own maps, as `CONFIG.DND5E` holds them. */
const MAPS = {
  weapon: { simpleM: "sim", simpleR: "sim", martialM: "mar", martialR: "mar" },
  armor: { natural: true, clothing: true, light: "lgt", medium: "med", heavy: "hvy", shield: "shl" }
};

const KNOWN = {
  classes: new Map([["bard", "bard"], ["paladin", "paladin"], ["wizard", "wizard"], ["sorcerer", "sorcerer"]]),
  species: new Map([["dwarf", "dwarf"], ["elf", "elf"]])
};

/** A character as {@link usabilityProfile} leaves it. */
const character = (overrides = {}) => ({
  armorProf: new Set(["lgt"]),
  weaponProf: new Set(["sim"]),
  strength: 10,
  classes: new Set(["wizard"]),
  species: new Set(["elf"]),
  spellcaster: true,
  ...overrides
});

describe("itemUsability", () => {
  it("warns about a weapon category the character is not trained in", () => {
    expect(itemUsability({ type: "weapon", subtype: "martialM" }, character(), MAPS).proficient).toBe(false);
    expect(itemUsability({ type: "weapon", subtype: "simpleM" }, character(), MAPS).proficient).toBe(true);
  });

  it("accepts proficiency in the specific base item, as an Elf's longsword training", () => {
    const elf = character({ weaponProf: new Set(["sim", "longsword"]) });
    expect(itemUsability({ type: "weapon", subtype: "martialM", baseItem: "longsword" }, elf, MAPS).proficient).toBe(true);
    expect(itemUsability({ type: "weapon", subtype: "martialM", baseItem: "greatsword" }, elf, MAPS).proficient).toBe(false);
  });

  it("never warns about a category the system has no key for", () => {
    expect(itemUsability({ type: "weapon", subtype: "natural" }, character(), MAPS).proficient).toBe(true);
    expect(itemUsability({ type: "equipment", subtype: "clothing" }, character(), MAPS).proficient).toBe(true);
    expect(itemUsability({ type: "equipment", subtype: "ring" }, character(), MAPS).proficient).toBe(true);
  });

  it("warns about armour and shields the character cannot wear well", () => {
    expect(itemUsability({ type: "equipment", subtype: "heavy" }, character(), MAPS).proficient).toBe(false);
    expect(itemUsability({ type: "equipment", subtype: "shield" }, character(), MAPS).proficient).toBe(false);
    expect(itemUsability({ type: "equipment", subtype: "light" }, character(), MAPS).proficient).toBe(true);
  });

  it("names the Strength heavy armour demands when the character falls short", () => {
    const plate = { type: "equipment", subtype: "heavy", strength: 15 };
    expect(itemUsability(plate, character({ strength: 13 }), MAPS).needsStrength).toBe(15);
    expect(itemUsability(plate, character({ strength: 15 }), MAPS).needsStrength).toBeNull();
  });

  it("has nothing to say about a potion", () => {
    expect(itemUsability({ type: "consumable", subtype: "potion" }, character(), MAPS))
      .toEqual({ proficient: true, needsStrength: null });
  });
});

describe("attunementRestriction", () => {
  it("reads one creature", () => {
    expect(attunementRestriction("<p><em>Wondrous Item, Rare (Requires Attunement by a Bard)</em></p>"))
      .toEqual({ who: "a Bard", names: ["bard"] });
  });

  it("reads a list", () => {
    expect(attunementRestriction("(Requires Attunement by a Sorcerer, Warlock, or Wizard)").names)
      .toEqual(["sorcerer", "warlock", "wizard"]);
  });

  it("reduces a content link to its label", () => {
    const html = "(Requires Attunement by a Dwarf or a Creature Attuned to a @UUID[Compendium.x.y.Item.z]{Belt of Dwarvenkind})";
    expect(attunementRestriction(html).who).toBe("a Dwarf or a Creature Attuned to a Belt of Dwarvenkind");
  });

  it("stops at the end of the paragraph", () => {
    expect(attunementRestriction("<p>Requires attunement by a Paladin</p><p>It glows.</p>").who).toBe("a Paladin");
  });

  it("is null when attunement is open to anyone, or not needed", () => {
    expect(attunementRestriction("<p>Wondrous Item, Rare (Requires Attunement)</p>")).toBeNull();
    expect(attunementRestriction("")).toBeNull();
    expect(attunementRestriction(undefined)).toBeNull();
  });
});

describe("unmetAttunement", () => {
  const bardOnly = { who: "a Bard", names: ["bard"] };

  it("names who may attune when the character is not one of them", () => {
    expect(unmetAttunement(bardOnly, character(), KNOWN)).toBe("a Bard");
  });

  it("is satisfied by any one of the listed classes or species", () => {
    const either = { who: "a Wizard or a Dwarf", names: ["wizard", "dwarf"] };
    expect(unmetAttunement(either, character(), KNOWN)).toBeNull();
    expect(unmetAttunement(either, character({ classes: new Set(), species: new Set(["dwarf"]) }), KNOWN)).toBeNull();
  });

  it("reads a spellcaster as the rules do", () => {
    const casters = { who: "a Spellcaster", names: ["spellcaster"] };
    expect(unmetAttunement(casters, character(), KNOWN)).toBeNull();
    expect(unmetAttunement(casters, character({ spellcaster: false }), KNOWN)).toBe("a Spellcaster");
  });

  it("says nothing about a limit it cannot fully judge", () => {
    const odd = { who: "a Bard or a Creature of Good Alignment", names: ["bard", "creature of good alignment"] };
    expect(unmetAttunement(odd, character(), KNOWN)).toBeNull();
  });

  it("matches a class by name as well as by identifier", () => {
    const byName = character({ classes: new Set(["paladin"]) });
    expect(unmetAttunement({ who: "a Paladin", names: ["paladin"] }, byName, KNOWN)).toBeNull();
  });
});

describe("usabilityProfile", () => {
  it("reads proficiencies, Strength, classes, species and casting off a dnd5e actor", () => {
    const actor = {
      system: {
        traits: { armorProf: { value: new Set(["lgt", "med"]) }, weaponProf: { value: new Set(["sim"]) } },
        abilities: { str: { value: 14 } }
      },
      classes: { wizard: { identifier: "wizard", name: "Wizard", spellcasting: { progression: "full" } } },
      itemTypes: { race: [{ system: { identifier: "hill-dwarf" }, name: "Hill Dwarf" }] }
    };
    const profile = usabilityProfile(actor);
    expect([...profile.armorProf]).toEqual(["lgt", "med"]);
    expect(profile.strength).toBe(14);
    expect([...profile.classes]).toEqual(["wizard"]);
    expect([...profile.species]).toEqual(["hill-dwarf", "hill dwarf"]);
    expect(profile.spellcaster).toBe(true);
  });

  it("counts a subclass that casts, as an Eldritch Knight's", () => {
    const actor = {
      system: { traits: {}, abilities: {} },
      classes: {
        fighter: {
          identifier: "fighter", name: "Fighter", spellcasting: { progression: "none" },
          subclass: { spellcasting: { progression: "third" } }
        }
      }
    };
    expect(usabilityProfile(actor).spellcaster).toBe(true);
    actor.classes.fighter.subclass = null;
    expect(usabilityProfile(actor).spellcaster).toBe(false);
  });

  it("is null with no character to read", () => {
    expect(usabilityProfile(null)).toBeNull();
  });
});

describe("proficiencyMaps", () => {
  it("reads the system's maps and indexes every class and species by id and name", () => {
    const maps = proficiencyMaps({
      config: { armorProficienciesMap: MAPS.armor, weaponProficienciesMap: MAPS.weapon },
      registry: { classes: { choices: { bard: "Bard" } }, species: { choices: { "hill-dwarf": "Hill Dwarf" } } }
    });
    expect(maps.weapon.martialM).toBe("mar");
    expect(maps.known.classes.get("bard")).toBe("bard");
    expect(maps.known.species.get("hill dwarf")).toBe("hill-dwarf");
  });

  it("copes with a system that has neither", () => {
    const maps = proficiencyMaps({ config: undefined, registry: undefined });
    expect(maps).toEqual({ armor: {}, weapon: {}, known: { classes: new Map(), species: new Map() } });
  });
});

describe("usabilityNotes", () => {
  const maps = { ...MAPS, known: KNOWN };
  const plate = {
    type: "equipment",
    system: { type: { value: "heavy", baseItem: "plate" }, strength: 15, description: { value: "" } }
  };

  it("reads the fields straight off an item", () => {
    expect(usabilityFields(plate)).toEqual({ type: "equipment", subtype: "heavy", baseItem: "plate", strength: 15 });
  });

  it("collects every reason, and is null when there is none", () => {
    expect(usabilityNotes(plate, character(), maps))
      .toEqual({ notProficient: true, needsStrength: 15, attunementBy: null });
    const fighter = character({ armorProf: new Set(["hvy"]), strength: 16 });
    expect(usabilityNotes(plate, fighter, maps)).toBeNull();
  });

  it("is null with no character to judge", () => {
    expect(usabilityNotes(plate, null, maps)).toBeNull();
  });

  it("uses the attunement a made item carries, not its base item's description", () => {
    const made = { type: "weapon", system: { type: { value: "simpleM" }, description: { value: "<p>A dagger.</p>" } } };
    expect(attunementFor(made, { attunement: "a Paladin" })).toEqual({ who: "a Paladin", names: ["paladin"] });
    expect(attunementFor(made, {})).toBeNull();
    expect(usabilityNotes(made, character(), maps, { attunement: "a Paladin" }).attunementBy).toBe("a Paladin");
  });
});

describe("making an item from a template limited to one class", () => {
  it("records who may attune, since the made item wears its base's description", () => {
    const template = {
      name: "Holy Avenger",
      type: "weapon",
      system: {
        properties: ["mgc"],
        type: { value: "" },
        description: { value: "<p><em>Weapon (Any Sword), Legendary (Requires Attunement by a Paladin)</em></p>" },
        activities: { a: { _id: "a", type: "enchant", effects: [{ _id: "p", riders: {} }], restrictions: {} } }
      },
      effects: [{ _id: "p", name: "Holy Avenger", type: "enchantment", system: { changes: [] } }]
    };
    const [profile] = enchantProfiles(template);
    const base = { name: "Longsword", type: "weapon", system: { description: { value: "<p>A sword.</p>" } }, effects: [] };
    const data = enchantedItemData({ base, baseUuid: "B", template, templateUuid: "T", profile, newId: () => "x" });
    expect(data.flags[MODULE].madeFrom.attunement).toBe("a Paladin");
    expect(attunementFor(data, data.flags[MODULE].madeFrom).names).toEqual(["paladin"]);
  });

  it("records nothing when anyone may attune", () => {
    const template = {
      name: "Weapon +1", type: "weapon",
      system: { properties: ["mgc"], type: { value: "" }, description: { value: "<p>Weapon (Any), Uncommon</p>" },
        activities: { a: { _id: "a", type: "enchant", effects: [{ _id: "p", riders: {} }], restrictions: {} } } },
      effects: [{ _id: "p", name: "+1", type: "enchantment", system: { changes: [] } }]
    };
    const [profile] = enchantProfiles(template);
    const data = enchantedItemData({
      base: { type: "weapon", system: {}, effects: [] }, baseUuid: "B", template, templateUuid: "T", profile, newId: () => "x"
    });
    expect("attunement" in data.flags[MODULE].madeFrom).toBe(false);
  });
});
