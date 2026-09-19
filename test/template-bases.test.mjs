import { describe, expect, it } from "vitest";
import {
  isMakeable, madeIdentity, madeItemData, shellItemData, shellProfile, templateBaseChoices, templateEntries
} from "../scripts/data/enchant.mjs";
import {
  SHELL_PROFILE, baseMatchesRule, baseRuleFor, baseRuleFromText, headline, headlineRarity, isShell, linkedBaseUuids,
  mightBeShell, shellBases, shellName
} from "../scripts/data/template-bases.mjs";

const MODULE = "sogrom-simple-dnd5e-magic-shop";

/** dnd5e's base items, as `enchant.mjs#baseItems` summarises them. */
const base = (uuid, name, type, subtype, extra = {}) => ({ uuid, name, type, subtype, properties: [], valueCp: 1000, ...extra });
const POOL = [
  base("B.dagger", "Dagger", "weapon", "simpleM", { properties: ["fin", "lgt", "thr"], damageTypes: ["piercing"], valueCp: 200 }),
  base("B.club", "Club", "weapon", "simpleM", { properties: ["lgt"], damageTypes: ["bludgeoning"], valueCp: 10 }),
  base("B.longsword", "Longsword", "weapon", "martialM", { properties: ["ver"], damageTypes: ["slashing"], valueCp: 1500 }),
  base("B.shortsword", "Shortsword", "weapon", "martialM", { properties: ["fin", "lgt"], damageTypes: ["piercing"] }),
  base("B.scimitar", "Scimitar", "weapon", "martialM", { properties: ["fin", "lgt"], damageTypes: ["slashing"] }),
  base("B.battleaxe", "Battleaxe", "weapon", "martialM", { damageTypes: ["slashing"] }),
  base("B.longbow", "Longbow", "weapon", "martialR", { damageTypes: ["piercing"] }),
  base("B.handxbow", "Hand Crossbow", "weapon", "martialR", { damageTypes: ["piercing"] }),
  base("B.heavyxbow", "Heavy Crossbow", "weapon", "martialR", { damageTypes: ["piercing"] }),
  base("B.lightxbow", "Light Crossbow", "weapon", "simpleR", { damageTypes: ["piercing"] }),
  base("B.arrows", "Arrows", "consumable", "ammo"),
  base("B.leather", "Leather Armor", "equipment", "light"),
  base("B.studded", "Studded Leather Armor", "equipment", "light"),
  base("B.hide", "Hide Armor", "equipment", "medium"),
  base("B.breastplate", "Breastplate", "equipment", "medium"),
  base("B.halfplate", "Half Plate Armor", "equipment", "medium"),
  base("B.plate", "Plate Armor", "equipment", "heavy", { valueCp: 150000 }),
  base("B.shield", "Shield", "equipment", "shield")
];
const names = list => list.map(b => b.name).sort();

const html = line => ({ system: { description: { value: `<p><em>${line}</em></p><p>The prose.</p>` } } });

/* -------------------------------------------- */
/*  The headline                                */
/* -------------------------------------------- */

describe("the headline", () => {
  it("is the first paragraph, when it names a rarity", () => {
    expect(headline(html("Weapon (Any Sword), Rare"))).toBe("Weapon (Any Sword), Rare");
    expect(headlineRarity(html("Armor (Any Medium or Heavy), Very Rare"))).toBe("veryrare");
  });

  it("ends at a line break, as other modules set it", () => {
    const item = { system: { description: { value: "<p>Weapon (Longbow), Uncommon<br>It burns.</p>" } } };
    expect(headline(item)).toBe("Weapon (Longbow), Uncommon");
  });

  it("is nothing when the item opens straight into prose", () => {
    expect(headline({ system: { description: { value: "<p>This @UUID[Compendium.a.b.Item.c]{Arrow} slays.</p>" } } })).toBe("");
    expect(headline({})).toBe("");
  });

  it("links its bases as Item uuids, filling in a type the link left out", () => {
    const item = html("@UUID[Compendium.dnd5e.equipment24.Item.wand]{Wand}, Uncommon; @UUID[Compendium.dnd5e.items.abc]{Sword}; @UUID[JournalEntry.j]{Rules}");
    expect(linkedBaseUuids(item)).toEqual(["Compendium.dnd5e.equipment24.Item.wand", "Compendium.dnd5e.items.Item.abc"]);
  });
});

/* -------------------------------------------- */
/*  Rules                                       */
/* -------------------------------------------- */

describe("baseRuleFromText", () => {
  it("reads weapon classes and reaches", () => {
    expect(baseRuleFromText("Weapon (Any Simple or Martial)").weaponTypes).toEqual(["simpleM", "simpleR", "martialM", "martialR"]);
    expect(baseRuleFromText("Weapon (Any Martial Melee)").weaponTypes).toEqual(["martialM"]);
  });

  it("reads ammunition alone as no weapons at all", () => {
    expect(baseRuleFromText("Weapon (Any Ammunition)")).toMatchObject({ weaponTypes: [], ammo: true });
  });

  it("reads armour weights and an exception", () => {
    const rule = baseRuleFromText("Armor (Any Medium or Heavy, Except Hide Armor)");
    expect(rule).toMatchObject({ kind: "armor", armorTypes: ["medium", "heavy"], exclude: ["hide"] });
    expect(names(POOL.filter(b => baseMatchesRule(b, rule)))).toEqual(["Breastplate", "Half Plate Armor", "Plate Armor"]);
  });

  it("is null for anything that is not a weapon or armour", () => {
    expect(baseRuleFromText("Wondrous Item, Rare")).toBeNull();
  });
});

describe("baseRuleFor", () => {
  it("falls back on the template's own type when it has no headline", () => {
    expect(baseRuleFor({ type: "consumable", system: { type: { value: "ammo" } } })).toMatchObject({ ammo: true, weaponTypes: [] });
    expect(baseRuleFor({ type: "weapon", system: {} }).weaponTypes).toHaveLength(4);
    expect(baseRuleFor({ type: "equipment", system: { type: { value: "" } } }).armorTypes).toEqual(["light", "medium", "heavy"]);
  });

  it("says nothing about a wand or a ring", () => {
    expect(baseRuleFor({ type: "equipment", system: { type: { value: "ring" } } })).toBeNull();
    expect(baseRuleFor({ type: "loot", system: {} })).toBeNull();
  });
});

/* -------------------------------------------- */
/*  Shells                                      */
/* -------------------------------------------- */

/** "Bonfire Blade: Weapon (any sword), common" — written up in full with nothing underneath. */
const shell = (line, overrides = {}) => ({
  name: "Bonfire Blade",
  type: "weapon",
  img: "bonfire.webp",
  ...overrides,
  system: {
    type: { value: "martialM", baseItem: "" },
    damage: { base: { denomination: null } },
    properties: [],
    description: { value: `<p><em>${line}</em></p><p>It burns.</p>` },
    activities: {},
    ...overrides.system
  },
  effects: overrides.effects ?? []
});

describe("mightBeShell and isShell", () => {
  it("find a weapon with no base item and no damage", () => {
    expect(mightBeShell(shell("Weapon (Any Sword), Common"))).toBe(true);
    expect(isShell(shell("Weapon (Any Sword), Common"))).toBe(true);
  });

  it("find armour with no base item and no armour class", () => {
    const armour = shell("Armor (Light), Uncommon", { type: "equipment", system: { type: { value: "light" }, armor: { value: 0 } } });
    expect(isShell(armour)).toBe(true);
  });

  it("leave a finished weapon alone", () => {
    const sword = shell("Weapon (Any Sword), Common", { system: { type: { value: "martialM", baseItem: "longsword" } } });
    expect(mightBeShell(sword)).toBe(false);
    const armed = shell("Weapon (Any Sword), Common", { system: { damage: { base: { denomination: 8 } } } });
    expect(isShell(armed)).toBe(false);
  });

  it("need a headline of the right kind", () => {
    expect(isShell(shell("Wondrous Item, Common"))).toBe(false);
    expect(isShell(shell("Armor (Light), Common"))).toBe(false);
    expect(mightBeShell({ type: "equipment", system: { type: { value: "ring" } } })).toBe(false);
  });
});

describe("shellBases", () => {
  const bases = line => names(shellBases(shell(line), POOL));
  const armour = line => names(shellBases(shell(line, { type: "equipment", system: { type: { value: "" } } }), POOL));

  it("reads a family", () => {
    expect(bases("Weapon (Any Sword), Common")).toEqual(["Longsword", "Scimitar", "Shortsword"]);
    expect(bases("Weapon (Any Axe), Common")).toEqual(["Battleaxe"]);
  });

  it("reads named weapons, and a noun finished by its adjective", () => {
    expect(bases("Weapon (Dagger or Longbow), Common")).toEqual(["Dagger", "Longbow"]);
    expect(bases("Weapon (Crossbow, Heavy or Light), Common")).toEqual(["Heavy Crossbow", "Light Crossbow"]);
  });

  it("reads a class, a damage type and a property", () => {
    expect(bases("Weapon (Any Simple Melee), Common")).toEqual(["Club", "Dagger"]);
    expect(bases("Weapon (Any Slashing Martial Melee Weapon), Common")).toEqual(["Battleaxe", "Longsword", "Scimitar"]);
    expect(bases("Weapon (Any Simple Weapon with the Thrown Property), Common")).toEqual(["Dagger"]);
  });

  it("reads ammunition", () => {
    expect(bases("Weapon (Ammunition), Common")).toEqual(["Arrows"]);
  });

  it("reads armour by weight, by name, as metal, and as any", () => {
    expect(armour("Armor (Light), Common")).toEqual(["Leather Armor", "Studded Leather Armor"]);
    expect(armour("Armor (Leather), Common")).toEqual(["Leather Armor"]);
    expect(armour("Armor (Half Plate or Plate), Common")).toEqual(["Half Plate Armor", "Plate Armor"]);
    expect(armour("Armor (Metal), Common")).toEqual(["Breastplate", "Half Plate Armor", "Plate Armor"]);
    expect(armour("Armor (Any Medium, but not Hide), Common")).toEqual(["Breastplate", "Half Plate Armor"]);
    expect(armour("Armor (Any), Common")).not.toContain("Shield");
  });

  it("finds nothing for barding, which dnd5e has no base for", () => {
    expect(armour("Armor (Barding), Common")).toEqual([]);
  });

  it("names a made shell by its base only when there is more than one", () => {
    expect(shellName({ name: "Bonfire Blade" }, { name: "Longsword" }, 3)).toBe("Bonfire Blade (Longsword)");
    expect(shellName({ name: "Bonfire Blade" }, { name: "Longsword" }, 1)).toBe("Bonfire Blade");
  });
});

/* -------------------------------------------- */
/*  Choosing bases for a template               */
/* -------------------------------------------- */

/** A DMG-shaped template: no subtype, magical, one enchant activity with the given profiles. */
const template = ({ name = "Template", type = "weapon", line = "", restrictions = {}, rarity = "rare" } = {}) => ({
  name,
  type,
  system: {
    rarities: [rarity],
    price: { value: 0, denomination: "gp" },
    properties: ["mgc"],
    type: { value: "" },
    description: { value: line ? `<p><em>${line}</em></p>` : "" },
    activities: {
      a: { _id: "a", type: "enchant", effects: [{ _id: "p", riders: {} }],
        restrictions: { type: "", categories: [], properties: [], allowMagical: false, ...restrictions } }
    }
  },
  effects: [{ _id: "p", name, type: "enchantment", system: { changes: [{ key: "system.price.value", value: 4000, type: "add" }] } }]
});

describe("templateBaseChoices", () => {
  it("keeps to the bases a headline links", () => {
    const frostBrand = template({ name: "Frost Brand", line: "Weapon (@UUID[B.longsword]{Longsword} or @UUID[B.scimitar]{Scimitar}), Very Rare" });
    const linked = POOL.filter(b => ["B.longsword", "B.scimitar"].includes(b.uuid));
    const [choice] = templateBaseChoices({ template: frostBrand, bases: POOL, linked });
    expect(names(choice.bases)).toEqual(["Longsword", "Scimitar"]);
  });

  it("falls back on the wording when no linked base can take the enchantment", () => {
    const t = template({ line: "Weapon (Any Sword), Rare", restrictions: { type: "weapon" } });
    const [choice] = templateBaseChoices({ template: t, bases: POOL, linked: [base("X.wand", "Wand", "equipment", "wand")] });
    expect(names(choice.bases)).toEqual(expect.arrayContaining(["Longsword", "Dagger"]));
  });

  it("follows the wording when nothing is linked, so hide never takes Adamantine", () => {
    const adamantine = template({
      name: "Adamantine Armor", type: "equipment", line: "Armor (Any Medium or Heavy, Except Hide Armor), Uncommon",
      restrictions: { type: "equipment", categories: ["light", "medium", "heavy"] }
    });
    const [choice] = templateBaseChoices({ template: adamantine, bases: POOL });
    expect(names(choice.bases)).toEqual(["Breastplate", "Half Plate Armor", "Plate Armor"]);
  });

  it("still applies dnd5e's own restrictions on top of the wording", () => {
    const t = template({ line: "Weapon (Any Simple or Martial), Rare", restrictions: { categories: ["simpleM"] } });
    expect(names(templateBaseChoices({ template: t, bases: POOL })[0].bases)).toEqual(["Club", "Dagger"]);
  });

  it("ignores wording that would rule out every base dnd5e allows", () => {
    const t = template({ line: "Armor (Any Heavy), Rare", type: "weapon", restrictions: { type: "weapon", categories: ["simpleM"] } });
    expect(names(templateBaseChoices({ template: t, bases: POOL })[0].bases)).toEqual(["Club", "Dagger"]);
  });

  it("leaves the bases to dnd5e's rules alone when the template says nothing", () => {
    const wand = template({ type: "equipment", restrictions: { type: "equipment", categories: ["shield"] } });
    wand.system.type.value = "wand";
    expect(names(templateBaseChoices({ template: wand, bases: POOL })[0].bases)).toEqual(["Shield"]);
  });

  it("offers a shell as its one choice, on every base its headline names", () => {
    const [choice, ...rest] = templateBaseChoices({ template: shell("Weapon (Any Sword), Common"), bases: POOL });
    expect(rest).toEqual([]);
    expect(choice.profile.key).toBe(SHELL_PROFILE);
    expect(choice.profile.rarity).toBe("common");
    expect(names(choice.bases)).toEqual(["Longsword", "Scimitar", "Shortsword"]);
  });

  it("offers nothing for a shell whose headline names no base it can find", () => {
    const barding = shell("Armor (Barding), Rare", { type: "equipment", system: { type: { value: "" } } });
    expect(templateBaseChoices({ template: barding, bases: POOL })).toEqual([]);
  });

  it("offers nothing for an ordinary item", () => {
    expect(templateBaseChoices({ template: { type: "loot", system: {} }, bases: POOL })).toEqual([]);
  });
});

describe("isMakeable", () => {
  it("covers templates and shells, and nothing else", () => {
    expect(isMakeable(template())).toBe(true);
    expect(isMakeable(shell("Weapon (Any Sword), Common"))).toBe(true);
    expect(isMakeable({ type: "weapon", system: { type: { value: "martialM", baseItem: "longsword" }, damage: { base: { denomination: 8 } } } })).toBe(false);
  });
});

/* -------------------------------------------- */
/*  Pricing and making a shell                  */
/* -------------------------------------------- */

describe("a shell's price", () => {
  it("is its own listed price on top of the base, when it lists one", () => {
    expect(shellProfile(shell("Weapon (Any Sword), Common", { system: { price: { value: 150, denomination: "gp" } } })).priceAdd)
      .toEqual({ value: 15000, denomination: "cp" });
  });

  it("is its rarity's otherwise, in the generator's pool as anywhere", () => {
    const [entry] = templateEntries({ template: shell("Weapon (Any Sword), Common"), uuid: "S", bases: POOL });
    // The cheapest sword (Shortsword, 10 gp) plus a common item's 100 gp.
    expect(entry).toMatchObject({ kind: "enchant", profileKey: SHELL_PROFILE, type: "weapon", rarity: "common", valueCp: 11000 });
    expect(entry.subtypes).toEqual(["martialM"]);
  });
});

describe("shellItemData", () => {
  const baseData = (shape = "rarities") => ({
    _id: "gone", name: "Longsword", type: "weapon", img: "longsword.webp",
    system: {
      [shape]: shape === "rarities" ? [] : "",
      price: { value: 15, denomination: "gp" },
      properties: ["ver"],
      type: { value: "martialM", baseItem: "longsword" },
      description: { value: "<p>A sword.</p>" },
      activities: { swing: { type: "attack", damage: { parts: [] } } }
    },
    effects: []
  });
  const bonfire = () => shell("Weapon (Any Sword), Common", {
    system: {
      identifier: "bonfire-blade",
      attunement: "required",
      properties: ["fir"],
      activities: {
        empty: { type: "attack", damage: { parts: [] } },
        ignite: { type: "utility" }
      }
    },
    effects: [{ _id: "e1", name: "Warmth" }]
  });

  it("dresses the base as the shell, keeping the base's attack", () => {
    const data = shellItemData({ base: baseData(), baseUuid: "B.longsword", shell: bonfire(), shellUuid: "S", name: "Bonfire Blade (Longsword)" });
    expect(data._id).toBeUndefined();
    expect(data).toMatchObject({ name: "Bonfire Blade (Longsword)", img: "bonfire.webp", type: "weapon" });
    expect(data.system.type.baseItem).toBe("longsword");
    expect(data.system.description.value).toContain("It burns.");
    expect(data.system.identifier).toBe("bonfire-blade");
    expect(data.system.attunement).toBe("required");
    expect(data.system.properties.sort()).toEqual(["fir", "mgc", "ver"]);
    expect(Object.keys(data.system.activities).sort()).toEqual(["ignite", "swing"]);
    expect(data.effects.map(e => e.name)).toEqual(["Warmth"]);
  });

  it("writes the rarity in the shape the base item's data uses", () => {
    expect(shellItemData({ base: baseData(), baseUuid: "B", shell: bonfire(), shellUuid: "S" }).system.rarities).toEqual(["common"]);
    expect(shellItemData({ base: baseData("rarity"), baseUuid: "B", shell: bonfire(), shellUuid: "S" }).system.rarity).toBe("common");
  });

  it("prices it as the base plus the shell's rarity", () => {
    const data = shellItemData({ base: baseData(), baseUuid: "B", shell: bonfire(), shellUuid: "S" });
    // 15 gp + 100 gp.
    expect(data.system.price).toEqual({ value: 115, denomination: "gp" });
  });

  it("records what it was made from, so each base is its own line", () => {
    const data = shellItemData({ base: baseData(), baseUuid: "B.longsword", shell: bonfire(), shellUuid: "S" });
    expect(data.flags[MODULE].madeFrom).toEqual({ template: "S", profile: SHELL_PROFILE, base: "B.longsword" });
    expect(madeIdentity(data.flags[MODULE].madeFrom)).toBe("enchant:S:shell:B.longsword");
  });

  it("is what madeItemData builds for the shell choice, named by its base among several", () => {
    const [choice] = templateBaseChoices({ template: bonfire(), bases: POOL });
    const data = madeItemData({ template: bonfire(), templateUuid: "S", choice, base: baseData(), baseUuid: "B.longsword" });
    expect(data.name).toBe("Bonfire Blade (Longsword)");
    expect(data.flags[MODULE].madeFrom.profile).toBe(SHELL_PROFILE);
  });
});
