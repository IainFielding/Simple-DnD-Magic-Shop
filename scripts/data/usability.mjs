/**
 * Whether the character at the counter can make proper use of a shelf item, and why not.
 *
 * Three things stop a magic weapon or suit of armour being the prize it looks like:
 *
 *  - **Proficiency**, which a class or origin has to grant.
 *  - **Strength**, which plate and splint demand.
 *  - **Who may attune** — "Requires Attunement by a Paladin".
 *
 * None of them stops a purchase. A player may be buying for a later level, for a friend, or to sell
 * on, so the shop only *says* so: the tile carries a warning badge. The answers are worked out on the
 * GM's client, where the context is built (`trade/context.mjs`), and travel to the player as words.
 *
 * Adapted from the character creator's magic item step (`data/magic-shop.mjs` and
 * `data/magic-shop-source.mjs`), the same author's module. Everything but {@link proficiencyMaps}
 * is pure, and that takes its globals as a parameter so it can be tested too.
 */

/* -------------------------------------------- */
/*  Proficiency and Strength                    */
/* -------------------------------------------- */

/**
 * @typedef {object} UsabilityProfile
 * @property {Set<string>} armorProf    dnd5e armour proficiency keys ("lgt", "hvy") and base items.
 * @property {Set<string>} weaponProf   dnd5e weapon proficiency keys ("sim", "mar") and base items.
 * @property {number} strength          The Strength score.
 * @property {Set<string>} classes      Class identifiers and lower-cased names.
 * @property {Set<string>} species      Species identifiers and lower-cased names.
 * @property {boolean} spellcaster      Whether any class or subclass has a spellcasting progression.
 */

/**
 * Whether a character can use an item as it is meant to be used.
 *
 * The proficiency test mirrors the system's own (`EquipmentData#proficiencyMultiplier` and
 * `WeaponData#proficiencyMultiplier`): the item's category maps to a proficiency key, and the
 * character qualifies by holding that key *or* the specific base item ("longsword" for an Elf).
 * Anything that is not a weapon or armour needs no proficiency at all.
 * @param {{type: string, subtype: string, baseItem?: string, strength?: number|null}} item
 * @param {UsabilityProfile} character
 * @param {{armor?: Record<string, string|boolean>, weapon?: Record<string, string|boolean>}} [maps]
 *   The system's `armorProficienciesMap` / `weaponProficienciesMap`.
 * @returns {{proficient: boolean, needsStrength: number|null}}
 */
export function itemUsability(item, character, maps = {}) {
  const out = { proficient: true, needsStrength: null };
  if ( !item || !character ) return out;
  const subtype = item.subtype ?? "";
  const baseItem = item.baseItem ?? "";

  if ( item.type === "weapon" ) {
    const key = maps.weapon?.[subtype];
    // An unmapped category (natural, improvised) needs no training: the system only warns about
    // what it knows.
    if ( (key === undefined) || (key === true) ) out.proficient = true;
    else out.proficient = character.weaponProf.has(key) || (!!baseItem && character.weaponProf.has(baseItem));
  } else if ( item.type === "equipment" ) {
    const key = maps.armor?.[subtype];
    // Clothing and trinkets map to `true`, or not at all — worn, not armour.
    if ( (key === undefined) || (key === true) ) out.proficient = true;
    else out.proficient = character.armorProf.has(key) || (!!baseItem && character.armorProf.has(baseItem));

    const needed = Number(item.strength) || 0;
    if ( (needed > 0) && ((Number(character.strength) || 0) < needed) ) out.needsStrength = needed;
  }
  return out;
}

/* -------------------------------------------- */
/*  Attunement                                  */
/* -------------------------------------------- */

/**
 * Who an item's attunement is limited to, read from its description: "Requires Attunement by a Bard",
 * "by a Sorcerer, Warlock, or Wizard", "by a Spellcaster". dnd5e has no structured field for this —
 * `system.attunement` only says whether attunement is required — so the prose is the only source.
 *
 * Enricher links are reduced to their label first, so "by a Dwarf or a Creature Attuned to a
 * @UUID[…]{Belt of Dwarvenkind}" reads as the words a player sees.
 * @param {string} html  The item's description.
 * @returns {{who: string, names: string[]}|null}  The phrase as written ("a Bard") and its names,
 *   lower-cased with the articles dropped (["bard"]); null when the item names no one.
 */
export function attunementRestriction(html) {
  if ( !html ) return null;
  const text = String(html)
    .replace(/@\w+\[[^\]]*\](?:\{([^}]*)\})?/g, (_, label) => label ?? "")
    // A tag ends the phrase: the headline is often a paragraph of its own, and the text after it is
    // not part of who may attune.
    .replace(/<[^>]+>/g, "|")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const match = text.match(/requires attunement by ([^).;:|]+)/i);
  if ( !match ) return null;
  const who = match[1].trim();
  const names = who.split(/,|\bor\b|\band\b/i)
    .map(s => s.trim().replace(/^(?:an?|the)\s+/i, "").toLowerCase())
    .filter(Boolean);
  return names.length ? { who, names } : null;
}

/**
 * Whether the character is one of the creatures an item's attunement is limited to — the attunement
 * counterpart of {@link itemUsability}, and like it a note, never a block.
 *
 * Only a limit this can fully judge is reported. Every name must be "spellcaster" or a class or species
 * the system knows; one it cannot place ("a Creature of the Weapon's Choice", "a Creature Attuned to a
 * Belt of Dwarvenkind", an alignment) makes the whole limit undecidable, and an item the character might
 * well qualify for is better left unmarked than wrongly marked.
 * @param {{who: string, names: string[]}|null} restriction  From {@link attunementRestriction}.
 * @param {UsabilityProfile} character
 * @param {{classes?: Map<string, string>, species?: Map<string, string>}} [known]
 *   Every class and species the system knows, lower-cased name (and identifier) → identifier.
 * @returns {string|null}  The phrase to show ("a Bard") when the character is none of them, else null.
 */
export function unmetAttunement(restriction, character, known = {}) {
  if ( !restriction?.names?.length || !character ) return null;
  let met = false;
  for ( const name of restriction.names ) {
    if ( name === "spellcaster" ) {
      met ||= !!character.spellcaster;
      continue;
    }
    const cls = known.classes?.get(name);
    const species = known.species?.get(name);
    if ( !cls && !species ) return null;
    if ( cls && (character.classes?.has(cls) || character.classes?.has(name)) ) met = true;
    if ( species && (character.species?.has(species) || character.species?.has(name)) ) met = true;
  }
  return met ? null : restriction.who;
}

/* -------------------------------------------- */
/*  Reading the character and the item         */
/* -------------------------------------------- */

/**
 * What {@link itemUsability} and {@link unmetAttunement} need to know about a character: the
 * proficiencies they hold, their Strength, their classes and species (identifier and lower-cased
 * name both, so a limit matches either), and whether any class casts. "Spellcaster" is read as the
 * rules define it, a Spellcasting or Pact Magic feature — a class or subclass with a progression, so
 * an Eldritch Knight counts and a Fighter with Magic Initiate does not.
 * @param {object|null} actor
 * @returns {UsabilityProfile|null}
 */
export function usabilityProfile(actor) {
  if ( !actor ) return null;
  const traits = actor.system?.traits ?? {};
  const classes = Object.values(actor.classes ?? {});
  const species = actor.itemTypes?.race ?? [];
  const keys = items => new Set(items
    .flatMap(i => [i.identifier ?? i.system?.identifier, i.name?.toLowerCase()])
    .filter(Boolean));
  const progression = item => item?.spellcasting?.progression ?? item?.system?.spellcasting?.progression;
  const casts = item => !!progression(item) && (progression(item) !== "none");
  return {
    armorProf: new Set(traits.armorProf?.value ?? []),
    weaponProf: new Set(traits.weaponProf?.value ?? []),
    strength: Number(actor.system?.abilities?.str?.value ?? 0),
    classes: keys(classes),
    species: keys(species),
    spellcaster: classes.some(c => casts(c) || casts(c.subclass))
  };
}

/**
 * The system's category → proficiency-key maps, and every class and species it knows.
 * @param {object} [globals]  Injected for tests.
 * @param {object} [globals.config]    `CONFIG.DND5E`.
 * @param {object} [globals.registry]  `dnd5e.registry`, whose `classes` and `species` list every
 *   class and species in the world and its packs.
 * @returns {{armor: object, weapon: object, known: {classes: Map<string, string>, species: Map<string, string>}}}
 */
export function proficiencyMaps({ config = globalThis.CONFIG?.DND5E, registry = globalThis.dnd5e?.registry } = {}) {
  const lookup = source => {
    const map = new Map();
    let choices = {};
    try { choices = source?.choices ?? {}; } catch { choices = {}; }
    for ( const [id, name] of Object.entries(choices) ) {
      map.set(id.toLowerCase(), id);
      if ( name ) map.set(String(name).toLowerCase(), id);
    }
    return map;
  };
  return {
    armor: config?.armorProficienciesMap ?? {},
    weapon: config?.weaponProficienciesMap ?? {},
    known: { classes: lookup(registry?.classes), species: lookup(registry?.species) }
  };
}

/**
 * What {@link itemUsability} reads off an item: its kind, its category and base item, and — for
 * armour — the Strength it demands.
 * @param {object} item  A document or its data.
 * @returns {{type: string, subtype: string, baseItem: string, strength: number|null}}
 */
export function usabilityFields(item) {
  const type = item?.system?.type ?? {};
  return {
    type: item?.type ?? "",
    subtype: typeof type.value === "string" ? type.value : "",
    baseItem: typeof type.baseItem === "string" ? type.baseItem : "",
    strength: Number(item?.system?.strength) || null
  };
}

/**
 * Who may attune to an item, from wherever it is recorded: an item the shop made from a template
 * keeps the template's phrase in `madeFrom.attunement` (its own description is the plain base
 * item's); anything else says it in its own description.
 * @param {object} item       A document or its data.
 * @param {object} [madeFrom] The item's `flags[MODULE_ID].madeFrom`.
 * @returns {{who: string, names: string[]}|null}
 */
export function attunementFor(item, madeFrom) {
  const phrase = madeFrom?.attunement;
  if ( (typeof phrase === "string") && phrase ) return attunementRestriction(`Requires attunement by ${phrase}`);
  return attunementRestriction(item?.system?.description?.value);
}

/**
 * @typedef {object} UsabilityNotes
 * @property {boolean} notProficient
 * @property {number|null} needsStrength  The score required, when the character falls short.
 * @property {string|null} attunementBy   Who may attune ("a Paladin"), when the character is not one.
 */

/**
 * Everything the tile should warn about, for one item and one character.
 * @param {object} item  A document or its data.
 * @param {UsabilityProfile|null} character
 * @param {ReturnType<typeof proficiencyMaps>} maps
 * @param {object} [madeFrom]  The item's `flags[MODULE_ID].madeFrom`; see {@link attunementFor}.
 * @returns {UsabilityNotes|null}  Null when there is nothing to warn about.
 */
export function usabilityNotes(item, character, maps, madeFrom) {
  if ( !character ) return null;
  const use = itemUsability(usabilityFields(item), character, maps);
  const attunementBy = unmetAttunement(attunementFor(item, madeFrom), character, maps?.known);
  if ( use.proficient && !use.needsStrength && !attunementBy ) return null;
  return { notProficient: !use.proficient, needsStrength: use.needsStrength, attunementBy };
}
