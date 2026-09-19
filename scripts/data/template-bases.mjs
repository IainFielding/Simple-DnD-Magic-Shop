import { normalizeRarity } from "../config.mjs";

/**
 * Which base items a magic item template — or a *shell* — belongs on, read from its description.
 *
 * dnd5e's enchant activity only says what *kind* of item an enchantment accepts ("a weapon", "a
 * martial melee weapon"). The item's own text is usually more exact:
 *
 *  - **Linked bases.** Frost Brand's headline links its six swords; Wand of the War Mage links the
 *    Wand. Those are the only bases it should ever go on.
 *  - **Wording.** "Weapon (Any Simple or Martial)", "Armor (Any Medium or Heavy, Except Hide Armor)".
 *    Without reading it, Adamantine Armor happily lands on hide.
 *  - **Shells.** Some packs (Griffon's Saddlebag's work-in-progress pack, mostly) write a magic weapon
 *    or armour up in full but never give it the item underneath — no base item, no damage, no AC —
 *    so on a sheet it can neither attack nor be worn. "Bonfire Blade: Weapon (any sword), common."
 *    A shell is made onto every base its headline names, taking the shell's name, art and text.
 *
 * Adapted from the character creator's `data/magic-templates.mjs`, the same author's module, which
 * grew these rules out of this module's `data/enchant.mjs`. Everything here is pure: plain objects in,
 * plain answers out; `data/enchant.mjs` loads the documents and builds the items.
 */

/** Rarity words as a headline spells them, rarest last so "Very Rare" is tested before "Rare". */
const HEADLINE_RARITY = /\b(very\s+rare|uncommon|common|rare|legendary|artifact|rarity\s+varies)\b/i;

/** A content link, with or without its label. */
const UUID_LINK = /@UUID\[[^\]]+\](\{[^}]*\})?/g;

/** A Set, an array or nothing, as an array of strings. */
function listOf(source) {
  if ( !source ) return [];
  return [...source].filter(v => typeof v === "string" && v);
}

/* -------------------------------------------- */
/*  The headline                                */
/* -------------------------------------------- */

/**
 * The item's own line of type and rarity: "{Wand}, Uncommon (+1)…", "Weapon (Any Simple or
 * Martial), Rare".
 *
 * The DMG sets it as an italic paragraph of its own; other modules open the first paragraph with it
 * and break to the prose with a `<br>` (Candleflame Bow). Either way it is the start of the first
 * paragraph up to the first break — and it only counts when it names a rarity, so a template that
 * opens straight into prose (Ammunition of Slaying) has no headline rather than a sentence of flavour
 * text whose links would be mistaken for bases.
 * @param {object} item  A document, its data, or an index entry carrying `system.description.value`.
 * @returns {string}  The headline's HTML, or "".
 */
export function headline(item) {
  const text = item?.system?.description?.value;
  if ( typeof text !== "string" ) return "";
  const first = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(text)?.[1] ?? "";
  const line = first.split(/<br\s*\/?>/i)[0].replace(/<\/?em>/gi, "").trim();
  return HEADLINE_RARITY.test(line.replace(UUID_LINK, "")) ? line : "";
}

/** The rarity a headline names first, normalised; "" when it names none. */
export function headlineRarity(item) {
  const word = HEADLINE_RARITY.exec(headline(item).replace(UUID_LINK, ""))?.[1];
  return normalizeRarity(word ?? "");
}

/**
 * The base items the headline links, in order: `@UUID[…]{Wand}`. A link written without its document
 * type (`Compendium.pkg.pack.id`, which Foundry still resolves) is read as an Item.
 * @param {object} item
 * @returns {string[]}
 */
export function linkedBaseUuids(item) {
  return [...headline(item).matchAll(/@UUID\[([^\]]+)\]/g)]
    .map(m => {
      const parts = m[1].split(".");
      return ((parts[0] === "Compendium") && (parts.length === 4)) ? [...parts.slice(0, 3), "Item", parts[3]].join(".") : m[1];
    })
    .filter(uuid => /\.Item\.[^.]+$/.test(uuid) || /^Item\.[^.]+$/.test(uuid));
}

/* -------------------------------------------- */
/*  Rules from the wording                      */
/* -------------------------------------------- */

/**
 * @typedef {object} BaseRule
 * @property {"weapon"|"armor"} kind
 * @property {string[]} weaponTypes  dnd5e weapon subtypes (simpleM, martialR…).
 * @property {boolean} ammo
 * @property {string[]} armorTypes   light/medium/heavy/shield.
 * @property {string[]} exclude      Lower-case name prefixes to leave out ("hide").
 */

/**
 * What an unlinked headline allows, from its wording: "Weapon (Any Simple or Martial)", "Weapon (Any
 * Ammunition or Melee Weapon)", "Armor (Any Medium or Heavy, Except Hide Armor)".
 * @param {string} text
 * @returns {BaseRule|null}  Null when the wording names no weapon or armour.
 */
export function baseRuleFromText(text) {
  const plainText = String(text ?? "").replace(/<[^>]+>/g, "").replace(/@UUID\[[^\]]+\]/g, "");
  const match = /^\s*(Weapon|Armou?r)\s*\(([^)]*)\)/i.exec(plainText);
  if ( !match ) return null;
  const inside = match[2].toLowerCase();
  const exclude = [...inside.matchAll(/except\s+([a-z' -]+?)\s+armou?r/g)].map(m => m[1].trim());

  if ( /^weapon/i.test(match[1]) ) {
    const simple = /\bsimple\b/.test(inside);
    const martial = /\bmartial\b/.test(inside);
    const melee = /\bmelee\b/.test(inside);
    const ranged = /\branged\b/.test(inside);
    const ammo = /\bammunition\b/.test(inside);
    const classes = (simple || martial) ? [simple && "simple", martial && "martial"].filter(Boolean) : ["simple", "martial"];
    const reaches = (melee || ranged) ? [melee && "M", ranged && "R"].filter(Boolean) : ["M", "R"];
    const anyWeapon = simple || martial || melee || ranged || !ammo;
    const weaponTypes = anyWeapon ? classes.flatMap(c => reaches.map(r => `${c}${r}`)) : [];
    return { kind: "weapon", weaponTypes, ammo, armorTypes: [], exclude };
  }

  const armorTypes = ["light", "medium", "heavy"].filter(type => new RegExp(`\\b${type}\\b`).test(inside));
  if ( /\bshield\b/.test(inside) ) armorTypes.push("shield");
  return { kind: "armor", weaponTypes: [], ammo: false, armorTypes: armorTypes.length ? armorTypes : ["light", "medium", "heavy"], exclude };
}

/**
 * Whether a base fits a rule.
 * @param {{name: string, type: string, subtype: string}} base
 * @param {BaseRule|null} rule
 * @returns {boolean}
 */
export function baseMatchesRule(base, rule) {
  if ( !rule ) return false;
  const name = String(base?.name ?? "").toLowerCase();
  if ( rule.exclude.some(prefix => name.startsWith(prefix)) ) return false;
  if ( rule.kind === "weapon" ) {
    if ( (base.type === "weapon") && rule.weaponTypes.includes(base.subtype) ) return true;
    return rule.ammo && (base.type === "consumable") && (base.subtype === "ammo");
  }
  return (base.type === "equipment") && rule.armorTypes.includes(base.subtype);
}

/**
 * The rule for an unlinked template: its headline's wording, or — when it has no headline, as
 * Ammunition of Slaying doesn't — its own item type (ammunition, any weapon, any body armour).
 * @param {object} template
 * @returns {BaseRule|null}  Null when neither says anything, which leaves the bases unnarrowed.
 */
export function baseRuleFor(template) {
  const fromText = baseRuleFromText(headline(template));
  if ( fromText ) return fromText;
  const subtype = template?.system?.type?.value ?? "";
  if ( (template?.type === "consumable") && (subtype === "ammo") ) {
    return { kind: "weapon", weaponTypes: [], ammo: true, armorTypes: [], exclude: [] };
  }
  if ( template?.type === "weapon" ) return baseRuleFromText("Weapon (Any Simple or Martial)");
  if ( (template?.type === "equipment") && ["", "light", "medium", "heavy"].includes(subtype) ) {
    return baseRuleFromText("Armor (Any Light, Medium, or Heavy)");
  }
  return null;
}

/* -------------------------------------------- */
/*  Shells                                      */
/* -------------------------------------------- */

/** The profile key a shell's one "enchantment" carries, where a template's is `activity.profile`. */
export const SHELL_PROFILE = "shell";

/** Weapon headline words that name a family of base weapons rather than one. */
const WEAPON_FAMILIES = {
  sword: /sword|scimitar|rapier/,
  axe: /axe$/,
  bow: /^(long|short)bow$/,
  crossbow: /crossbow/,
  hammer: /hammer/,
  spear: /spear|pike|lance|trident/,
  firearm: /pistol|musket|firearm/
};

/** Adjectives that finish the noun before them: "crossbow, heavy" is a Heavy Crossbow. */
const WEAPON_ADJECTIVES = new Set(["heavy", "light", "hand"]);

/** dnd5e's weapon property keys, by the word a headline uses. */
const WEAPON_PROPERTIES = {
  thrown: "thr", reach: "rch", heavy: "hvy", "two-handed": "two", special: "spc", finesse: "fin",
  light: "lgt", versatile: "ver", loading: "lod", ammunition: "amm"
};

/** Equipment subtypes a shell of armour can have: body armour, a shield, or none yet. */
const ARMOUR_SUBTYPES = ["", "light", "medium", "heavy", "shield"];

/**
 * Whether an index entry might be a shell, from what the index alone can tell: a weapon with no base
 * item and no damage die, or armour with no base item and no armour class. Only these are loaded to
 * read their headline. Needs `system.type`, `system.damage.base.denomination` and `system.armor.value`
 * in the index.
 * @param {object} entry  A compendium index entry, or a document.
 * @returns {boolean}
 */
export function mightBeShell(entry) {
  if ( entry?.system?.type?.baseItem ) return false;
  if ( entry?.type === "weapon" ) return !entry.system?.damage?.base?.denomination;
  if ( entry?.type === "equipment" ) {
    return ARMOUR_SUBTYPES.includes(entry.system?.type?.value ?? "") && !Number(entry.system?.armor?.value);
  }
  return false;
}

/**
 * Whether an item is a *shell*: a magic weapon or armour written up in full but never given the item
 * underneath it, whose headline says what that item should be.
 * @param {object} item
 * @returns {boolean}
 */
export function isShell(item) {
  if ( !mightBeShell(item) ) return false;
  const words = headlineWords(item);
  if ( !words ) return false;
  return words.kind === (item.type === "weapon" ? "weapon" : "armor");
}

/**
 * A headline's kind and its parenthesised wording: "Weapon (any sword)" → weapon, "any sword".
 * @returns {{kind: "weapon"|"armor", inside: string}|null}
 */
function headlineWords(item) {
  const text = headline(item).replace(/@UUID\[[^\]]+\]\{([^}]*)\}/g, "$1").replace(/<[^>]+>/g, "");
  const match = /^\s*(Weapon|Armou?r)\s*\(([^)]*)\)/i.exec(text);
  if ( !match ) return null;
  return { kind: /^weapon/i.test(match[1]) ? "weapon" : "armor", inside: match[2].toLowerCase() };
}

/** A name's words, singular: "arrow" matches "Arrows", "firearm bullet" matches "Bullets, Firearm". */
function nameWords(name) {
  return String(name ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean).map(w => w.replace(/s$/, ""));
}

/**
 * The bases a named token picks out. A base named exactly that ("leather" → Leather Armor, "sling"
 * → Sling) wins over one that merely contains the words (Studded Leather Armor, Sling Bullets).
 */
function namedBases(token, bases) {
  const want = nameWords(token).filter(w => w !== "armor");
  if ( !want.length ) return [];
  const exact = bases.filter(b => {
    const have = nameWords(b.name).filter(w => w !== "armor");
    return (have.length === want.length) && want.every(w => have.includes(w));
  });
  if ( exact.length ) return exact;
  const containing = bases.filter(b => want.every(w => nameWords(b.name).includes(w)));
  if ( containing.length || (want.length < 2) ) return containing;
  // "Blowgun needle" is dnd5e's Needles: fall back on the noun alone.
  return bases.filter(b => nameWords(b.name).includes(want.at(-1)));
}

/** Split a headline's wording into its listed parts. */
function headlineTokens(inside) {
  return inside.split(/,|\bor\b|\band\b|\//).map(token => token.trim()).filter(Boolean);
}

/**
 * The bases a shell's headline names, from dnd5e's base weapons, armour and ammunition.
 *
 * Armour reads "metal" (medium or heavy, but hide), a weight ("light", "any light armor"), named
 * pieces ("half plate or plate"), or nothing but "any". Weapons read a family ("any sword", "any
 * axe", "any bow"), a class or reach ("simple", "martial melee"), "any" alone, or named weapons
 * ("dagger and rapier", "crossbow, heavy or light", "arrow, bolt, or firearm bullet"). "But not hide"
 * and "except hide" leave hide out. Barding matches nothing: dnd5e has no base barding.
 * @param {object} item
 * @param {{name: string, type: string, subtype: string, properties: string[], damageTypes?: string[]}[]} pool
 * @returns {object[]}  Members of `pool`.
 */
export function shellBases(item, pool) {
  const words = headlineWords(item);
  if ( !words ) return [];
  let text = words.inside.replace(/\bhalfplate\b/g, "half plate").replace(/\b(?:a|an|the|piece of)\s+(?!propert)/g, "");
  // "With the thrown property", "without the reach or heavy property".
  const withProps = [];
  const withoutProps = [];
  text = text.replace(/\b(with|without)\s+(?:the\s+)?([a-z\- ]+?)\s+propert(?:y|ies)\b/g, (_, how, list) => {
    const keys = headlineTokens(list).map(p => WEAPON_PROPERTIES[p]).filter(Boolean);
    (how === "with" ? withProps : withoutProps).push(...keys);
    return "";
  });
  // "Any slashing or piercing simple weapon": the damage types, then the rest of the wording.
  const damageTypes = [...text.matchAll(/\b(bludgeoning|piercing|slashing)\b/g)].map(m => m[1]);
  text = text.replace(/\b(bludgeoning|piercing|slashing)\b/g, "").replace(/\bmetal\s+(?=melee|weapon)/g, "");
  const excluded = [...text.matchAll(/\b(?:but not|except)\s+([a-z]+)/g)].map(m => m[1].replace(/s$/, ""));
  const inside = text
    .replace(/\b(?:but not|except)\s+[a-z]+(?:\s+armou?r)?/g, "")
    .replace(/\barmou?r\b/g, "")
    .replace(/\bweapons?\b/g, "");
  const keep = base => {
    if ( excluded.some(x => nameWords(base.name).includes(x)) ) return false;
    const props = listOf(base.properties);
    if ( withProps.some(p => !props.includes(p)) || withoutProps.some(p => props.includes(p)) ) return false;
    return !damageTypes.length || !base.damageTypes || damageTypes.some(type => base.damageTypes.includes(type));
  };

  if ( words.kind === "armor" ) {
    if ( /\bbarding\b/.test(inside) ) return [];
    const armour = pool.filter(b => (b.type === "equipment") && ["light", "medium", "heavy", "shield"].includes(b.subtype));
    if ( /\bmetal\b/.test(inside) ) {
      return armour.filter(b => ["medium", "heavy"].includes(b.subtype) && !nameWords(b.name).includes("hide") && keep(b));
    }
    const weights = ["light", "medium", "heavy", "shield"];
    const tokens = headlineTokens(inside).map(token => token.replace(/\bany\b/g, "").trim()).filter(Boolean);
    const named = tokens.filter(token => !weights.includes(token));
    const weighted = tokens.filter(token => weights.includes(token));
    const found = new Set();
    for ( const b of armour ) if ( weighted.includes(b.subtype) ) found.add(b);
    for ( const token of named ) namedBases(token, armour).forEach(b => found.add(b));
    // "Any", "any armor": everything worn on the body.
    if ( !tokens.length ) armour.filter(b => b.subtype !== "shield").forEach(b => found.add(b));
    return [...found].filter(keep);
  }

  const weapons = pool.filter(b => (b.type === "weapon") || ((b.type === "consumable") && (b.subtype === "ammo")));
  const arms = weapons.filter(b => b.type === "weapon");
  const tokens = headlineTokens(inside);
  const found = new Set();
  let previousNoun = null;
  tokens.forEach((raw, i) => {
    const token = raw.replace(/\bany\b/g, "").trim();
    if ( WEAPON_ADJECTIVES.has(token) && previousNoun ) {
      for ( const b of weapons ) {
        const w = nameWords(b.name);
        if ( w.includes(token) && w.includes(previousNoun) ) found.add(b);
      }
      return;
    }
    previousNoun = nameWords(token).at(-1) ?? previousNoun;
    // A noun followed by its adjective ("crossbow, heavy") names only that version, read above.
    if ( WEAPON_ADJECTIVES.has(tokens[i + 1]) ) return;

    if ( /^ammunition$/.test(token) ) {
      weapons.filter(b => b.type === "consumable").forEach(b => found.add(b));
      return;
    }
    // "Any" on its own is every weapon; beside other words ("any … simple weapon") it adds nothing.
    if ( !token ) {
      if ( tokens.some(t => t.replace(/\bany\b/g, "").trim()) ) return;
      arms.filter(b => /^(simple|martial)[MR]$/.test(b.subtype)).forEach(b => found.add(b));
      return;
    }
    if ( /\b(simple|martial|melee|ranged)\b/.test(token) ) {
      const rule = baseRuleFromText(`Weapon (${token})`);
      arms.filter(b => baseMatchesRule(b, rule)).forEach(b => found.add(b));
      return;
    }
    const family = /\bany\b/.test(raw) && Object.entries(WEAPON_FAMILIES).find(([key]) => nameWords(token).includes(key));
    if ( family ) {
      arms.filter(b => family[1].test(b.name.toLowerCase().replace(/[^a-z]/g, ""))).forEach(b => found.add(b));
      return;
    }
    namedBases(token, weapons).forEach(b => found.add(b));
  });
  return [...found].filter(keep);
}

/** A made shell's name: the shell's own, with the base alongside when there is more than one. */
export function shellName(item, base, count) {
  return (count > 1) ? `${item.name} (${base.name})` : item.name;
}
