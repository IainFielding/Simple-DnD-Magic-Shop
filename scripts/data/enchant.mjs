import { MODULE_ID, PHYSICAL_TYPES, log, normalizeRarity } from "../config.mjs";
import { itemValueCp, toCopper } from "./pricing.mjs";
import { cpToPriceParts } from "./stock.mjs";

/**
 * Real magic items from the Dungeon Master's Guide's templates, and real scrolls from spells.
 *
 * ## The problem
 *
 * The 2024 DMG does not ship a "Longsword +1". It ships **"Weapon, +1, +2, or +3"** — a template
 * item with no base weapon, no damage and no price, carrying an *enchant activity* whose profiles
 * (+1, +2, +3) are enchantments a player is meant to apply to a weapon they own. Flame Tongue,
 * Dragon Slayer, Adamantine Armor and Armor of Resistance are all the same shape. Stocked as they
 * are, a shop shelves a sword with no blade; and the unpriced ones never reach a shelf at all.
 * Likewise the blank "Spell Scroll (Level 1)" is a scroll with no spell on it.
 *
 * ## What this does instead
 *
 * It builds the finished item: a real base item (the system's own Longsword, from
 * `CONFIG.DND5E.weaponIds`) with the template's enchantment embedded on it exactly as dnd5e would
 * apply it, riders included. dnd5e then does the rest when the item is prepared — the name becomes
 * "Longsword +1", the rarity uncommon, the attack bonus real — and so does our pricing, because the
 * DMG's enchantments add their own price (`system.price.value` +400 for a +1). Scrolls come from
 * dnd5e's own `createScrollFromSpell`, so a bought scroll is exactly the scroll the system makes.
 *
 * Because stock is real embedded items, the item is built **once, when it is stocked**. It is then
 * an ordinary line: it prices, restocks, sells and exports like anything else.
 *
 * The pure half is at the top — reading profiles, matching bases, valuing, and building item data
 * from plain objects — and the part that loads documents is below its banner.
 */

/** The DMG's price for a magic item of each rarity, in gold. Consumables cost half. */
export const RARITY_VALUE_GP = Object.freeze({
  common: 100, uncommon: 400, rare: 4000, veryrare: 40000, legendary: 200000
});

/** How many distinct scrolls of one spell level a single generation run can produce. */
export const SCROLLS_PER_LEVEL = 4;

/**
 * The DMG list value of a rarity, in copper.
 * @param {string} rarity       Normalised, as `config.mjs#normalizeRarity` returns it.
 * @param {object} [options]
 * @param {boolean} [options.consumable]
 * @returns {number}  0 for a rarity with no listed price (mundane, artifact).
 */
export function rarityValueCp(rarity, { consumable = false } = {}) {
  const gp = RARITY_VALUE_GP[rarity];
  if ( !gp ) return 0;
  return toCopper(consumable ? gp / 2 : gp, "gp");
}

/* -------------------------------------------- */
/*  Reading a template (pure)                   */
/* -------------------------------------------- */

/** Values from a Collection, a Map, an array or a plain object map, whichever arrived. */
function valuesOf(source) {
  if ( !source ) return [];
  if ( Array.isArray(source) ) return source;
  if ( Array.isArray(source.contents) ) return source.contents;
  if ( source instanceof Map ) return [...source.values()];
  if ( typeof source === "object" ) return Object.values(source);
  return [];
}

/** A Set, an array or nothing, as an array of strings. */
function listOf(source) {
  if ( !source ) return [];
  return [...source].filter(v => typeof v === "string" && v);
}

/** Plain data for an embedded document, whether a document or already data. */
function plain(doc) {
  return typeof doc?.toObject === "function" ? doc.toObject() : doc;
}

/** An effect's changes, from wherever this Foundry version keeps them. */
function changesOf(effect) {
  return valuesOf(effect?.system?.changes ?? effect?.changes);
}

/**
 * The value of the first change to a key, when it overrides or adds.
 * @param {object} effect
 * @param {string} key
 * @returns {*}  Undefined when the effect does not change it.
 */
function changeTo(effect, key) {
  return changesOf(effect).find(change => change?.key === key)?.value;
}

/**
 * @typedef {object} EnchantProfile
 * @property {string} key            `activityId.profileId`, unique within the template.
 * @property {string} activityId
 * @property {string} profileId      The enchantment effect's id on the template.
 * @property {string} name           The effect's name: "Weapon +1", "Armor of Fire Resistance".
 * @property {string} rarity         Normalised: the profile's own, else the template's.
 * @property {{value: number, denomination: string}|null} priceAdd  What the enchantment adds.
 * @property {{type: string, categories: string[], properties: string[], allowMagical: boolean}} restrictions
 * @property {{activity: string[], effect: string[]}} riders
 */

/**
 * Every enchantment a template can apply to an item a shop could sell.
 *
 * Skipped, deliberately:
 *  - **rider activities** — Flame Tongue's "Ablaze" is an enchant activity too, but it exists to
 *    toggle the blade alight once the sword is made, not to make one;
 *  - profiles that **grant items** as riders, which would put a second item into a buyer's pack
 *    that the shop never priced;
 *  - anything whose effect is missing or is not an enchantment.
 * @param {object} template  An item document, or its `toObject()` data.
 * @returns {EnchantProfile[]}
 */
export function enchantProfiles(template) {
  const activities = valuesOf(template?.system?.activities).filter(a => a?.type === "enchant");
  if ( !activities.length ) return [];
  const effects = new Map(valuesOf(template?.effects).map(e => {
    const data = plain(e);
    return [data?._id ?? e?.id, data];
  }));

  const riderActivities = new Set();
  for ( const activity of activities ) {
    for ( const profile of valuesOf(activity.effects) ) {
      for ( const id of listOf(profile?.riders?.activity) ) riderActivities.add(id);
    }
  }

  const templateRarity = normalizeRarity(template?.system?.rarity);
  const out = [];
  for ( const activity of activities ) {
    const activityId = activity._id ?? activity.id;
    if ( !activityId || riderActivities.has(activityId) ) continue;
    const restrictions = activity.restrictions ?? {};

    for ( const entry of valuesOf(activity.effects) ) {
      const profileId = entry?._id;
      const effect = effects.get(profileId);
      if ( !effect || (effect.type !== "enchantment" && effect.flags?.dnd5e?.type !== "enchantment") ) continue;
      if ( listOf(entry?.riders?.item).length ) continue;

      const addValue = Number(changeTo(effect, "system.price.value"));
      const addDenomination = changeTo(effect, "system.price.denomination");
      out.push({
        key: `${activityId}.${profileId}`,
        activityId,
        profileId,
        name: effect.name ?? "",
        rarity: normalizeRarity(changeTo(effect, "system.rarity")) || templateRarity,
        priceAdd: Number.isFinite(addValue) && addValue > 0
          ? { value: addValue, denomination: typeof addDenomination === "string" ? addDenomination : "gp" }
          : null,
        restrictions: {
          type: typeof restrictions.type === "string" ? restrictions.type : "",
          categories: listOf(restrictions.categories),
          properties: listOf(restrictions.properties),
          allowMagical: !!restrictions.allowMagical
        },
        riders: { activity: listOf(entry?.riders?.activity), effect: listOf(entry?.riders?.effect) }
      });
    }
  }
  return out;
}

/**
 * The item type an enchantment applies to: its own restriction, or the template's type — "Weapon,
 * +1, +2, or +3" restricts nothing and is itself a weapon.
 * @param {EnchantProfile} profile
 * @param {object} template
 * @returns {string}
 */
export function baseTypeFor(profile, template) {
  return profile?.restrictions?.type || template?.type || "";
}

/**
 * Whether a template is a *hollow* one this module should build a real item from, rather than stock
 * as it is: magical, with at least one usable enchantment, and missing the subtype or the price a
 * finished item has. "Berserker Axe", which is a whole axe that also carries an enchant activity,
 * is left alone.
 * @param {object} template
 * @returns {boolean}
 */
export function isHollowTemplate(template) {
  if ( !PHYSICAL_TYPES.includes(template?.type) ) return false;
  if ( !listOf(template?.system?.properties).includes("mgc") ) return false;
  const subtype = template?.system?.type?.value;
  const priced = itemValueCp(template?.system?.price) > 0;
  if ( subtype && priced ) return false;
  return enchantProfiles(template).length > 0;
}

/**
 * @typedef {object} BaseSummary
 * @property {string} uuid
 * @property {string} name
 * @property {string} img
 * @property {string} type
 * @property {string} subtype
 * @property {string[]} properties
 * @property {number} valueCp
 */

/**
 * The base items an enchantment may be applied to, by dnd5e's own `canEnchant` rules: the type,
 * the categories (subtypes) and properties it names, and no magic items unless it allows them.
 * @param {EnchantProfile} profile
 * @param {string} type             From {@link baseTypeFor}.
 * @param {BaseSummary[]} bases
 * @returns {BaseSummary[]}
 */
export function eligibleBases(profile, type, bases) {
  const { categories = [], properties = [], allowMagical = false } = profile?.restrictions ?? {};
  return (bases ?? []).filter(base => {
    if ( !type || base.type !== type ) return false;
    if ( categories.length && !categories.includes(base.subtype) ) return false;
    if ( properties.length && !properties.some(p => base.properties.includes(p)) ) return false;
    if ( !allowMagical && base.properties.includes("mgc") ) return false;
    return true;
  });
}

/**
 * What an enchanted item is worth, in copper.
 *
 * The enchantment's own price when it names one (the DMG's do: +400 gp for a +1 weapon); otherwise
 * the DMG price for its rarity; otherwise whatever the template itself was listed at. Always on top
 * of the base item's value, so +1 plate costs more than a +1 dagger — as mundane plate does.
 * @param {object} params
 * @param {number} params.baseValueCp
 * @param {EnchantProfile} params.profile
 * @param {number} [params.templateValueCp]
 * @param {boolean} [params.consumable]
 * @returns {number}
 */
export function enchantedValueCp({ baseValueCp = 0, profile, templateValueCp = 0, consumable = false }) {
  return Math.max(0, Math.round(baseValueCp)) + enchantmentValueCp({ profile, templateValueCp, consumable });
}

/** The enchantment's own share of {@link enchantedValueCp}. */
export function enchantmentValueCp({ profile, templateValueCp = 0, consumable = false }) {
  if ( profile?.priceAdd ) return toCopper(profile.priceAdd.value, profile.priceAdd.denomination);
  return rarityValueCp(profile?.rarity, { consumable }) || Math.max(0, Math.round(templateValueCp));
}

/**
 * The creation data for an enchanted item: the base item, with the template's enchantment and its
 * riders embedded the way dnd5e's own `EnchantActivity#applyEnchantment` builds them.
 *
 * The enchantment's `origin` is deliberately left unset. dnd5e uses it to re-run `canEnchant`
 * whenever the effect is created — including when a buyer's copy is made from the Trader's — and by
 * then the item is magical, which a "no magic items" enchantment would refuse. The profile and the
 * activity are still recorded in `system.origin` and the profile flag, as dnd5e records them.
 *
 * @param {object} params
 * @param {object} params.base           The base item's `toObject()` data.
 * @param {string} params.baseUuid
 * @param {object} params.template       The template item's `toObject()` data.
 * @param {string} params.templateUuid
 * @param {EnchantProfile} params.profile
 * @param {() => string} [params.newId]  Injected so a test can pin ids.
 * @returns {object}
 */
export function enchantedItemData({ base, baseUuid, template, templateUuid, profile, newId }) {
  const id = newId ?? (() => foundry.utils.randomID());
  const data = structuredClone(base);
  for ( const field of ["_id", "folder", "sort", "ownership"] ) delete data[field];

  const effects = new Map(valuesOf(template?.effects).map(e => [e._id, e]));
  const enchantId = id();
  const enchantment = structuredClone(effects.get(profile.profileId));
  Object.assign(enchantment, { _id: enchantId, transfer: true, disabled: false });
  delete enchantment.origin;
  enchantment.flags = { ...enchantment.flags, dnd5e: { ...enchantment.flags?.dnd5e, enchantmentProfile: profile.profileId } };
  enchantment.system = {
    ...enchantment.system,
    origin: { activity: `${templateUuid}.Activity.${profile.activityId}`, profile: profile.profileId }
  };

  // Riders: extra effects and activities the enchantment brings with it (the resistance on Armor
  // of Resistance, the "Ablaze" toggle on a Flame Tongue), each marked dependent on it as dnd5e does.
  const riderEffects = profile.riders.effect.map(riderId => {
    const rider = effects.get(riderId);
    if ( !rider ) return null;
    const copy = structuredClone(rider);
    copy._id = id();
    delete copy.origin;
    copy.flags = { ...copy.flags, dnd5e: { ...copy.flags?.dnd5e, dependentOn: enchantId } };
    delete copy.flags.dnd5e.rider;
    return copy;
  }).filter(Boolean);

  const activities = { ...(data.system?.activities ?? {}) };
  const templateActivities = template?.system?.activities ?? {};
  for ( const riderId of profile.riders.activity ) {
    const rider = templateActivities[riderId];
    if ( !rider ) continue;
    const copy = structuredClone(rider);
    copy._id = id();
    copy.flags = { ...copy.flags, dnd5e: { ...copy.flags?.dnd5e, dependentOn: enchantId } };
    activities[copy._id] = copy;
    // The effects a rider *activity* applies travel with their ids intact: the activity finds them
    // by id, and dnd5e recognises an effect an activity points at as belonging to the activity, so it
    // is not applied to the item until the activity is used.
    for ( const ref of valuesOf(rider.effects) ) {
      const effect = effects.get(ref?._id);
      const have = [...valuesOf(data.effects), ...riderEffects].some(e => e?._id === ref?._id);
      if ( effect && !have ) riderEffects.push(structuredClone(effect));
    }
  }

  data.system = { ...data.system, activities };
  data.effects = [...valuesOf(data.effects), enchantment, ...riderEffects];

  // An enchantment that names no price of its own would leave a magic item at its base item's
  // price. Fold the DMG rarity price into the base price instead.
  if ( !profile.priceAdd ) {
    const extra = enchantmentValueCp({
      profile,
      templateValueCp: itemValueCp(template?.system?.price),
      consumable: data.type === "consumable"
    });
    if ( extra > 0 ) data.system.price = cpToPriceParts(itemValueCp(data.system?.price) + extra);
  }

  data._stats = { ...data._stats, compendiumSource: baseUuid ?? null };
  data.flags = {
    ...data.flags,
    [MODULE_ID]: {
      ...data.flags?.[MODULE_ID],
      madeFrom: { template: templateUuid, profile: profile.key, base: baseUuid ?? "" }
    }
  };
  return data;
}

/**
 * The identity a made item is recognised by, so adding "Longsword +1" twice raises one line rather
 * than making two — while a Longsword +1 and a Flame Tongue Longsword stay separate lines, though
 * they share a base item.
 * @param {object} [madeFrom]  `flags[MODULE_ID].madeFrom`.
 * @returns {string}  "" for an item that was not made by the shop.
 */
export function madeIdentity(madeFrom) {
  if ( !madeFrom || typeof madeFrom !== "object" ) return "";
  if ( madeFrom.spell ) return `scroll:${madeFrom.spell}`;
  if ( madeFrom.template ) return `enchant:${madeFrom.template}:${madeFrom.profile}:${madeFrom.base}`;
  return "";
}

/**
 * The generator pool entries a template contributes: one per enchantment that has a base to go on.
 *
 * Each is priced from the **cheapest** eligible base, so a price ceiling admits it whenever at least
 * one version would fit; the base is then chosen within the ceiling when the item is made.
 * @param {object} params
 * @param {object} params.template      The template's data or document.
 * @param {string} params.uuid
 * @param {string} params.pack
 * @param {string} params.packLabel
 * @param {BaseSummary[]} params.bases
 * @returns {object[]}  Pool entries with `kind: "enchant"`.
 */
export function templateEntries({ template, uuid, pack = "", packLabel = "", bases }) {
  const out = [];
  for ( const profile of enchantProfiles(template) ) {
    const type = baseTypeFor(profile, template);
    const eligible = eligibleBases(profile, type, bases);
    if ( !eligible.length ) continue;
    const cheapest = Math.min(...eligible.map(b => b.valueCp));
    out.push({
      kind: "enchant",
      uuid,
      key: `${uuid}#${profile.key}`,
      profileKey: profile.key,
      templateName: template.name ?? "",
      name: profile.name || template.name,
      img: template.img ?? "icons/svg/item-bag.svg",
      type,
      subtype: "",
      subtypes: [...new Set(eligible.map(b => b.subtype).filter(Boolean))],
      rarity: profile.rarity,
      valueCp: enchantedValueCp({
        baseValueCp: cheapest,
        profile,
        templateValueCp: itemValueCp(template?.system?.price),
        consumable: type === "consumable"
      }),
      pack,
      packLabel
    });
  }
  return out;
}

/**
 * Pick the base for an enchantment being made for a recipe: one that fits the recipe's kinds and,
 * with the enchantment's value added, its price ceiling.
 * @param {object} params
 * @param {BaseSummary[]} params.eligible
 * @param {Set<string>|string[]} [params.categories]  The recipe's category tokens; empty means any.
 * @param {number} [params.maxValueCp]                0 means no ceiling.
 * @param {number} [params.enchantCp]                 What the enchantment adds.
 * @param {() => number} [params.rng]
 * @returns {BaseSummary|null}
 */
export function pickBase({ eligible, categories = [], maxValueCp = 0, enchantCp = 0, rng = Math.random }) {
  const wanted = new Set(categories);
  const fits = (eligible ?? []).filter(base => {
    if ( wanted.size && !wanted.has(base.type) && !wanted.has(`${base.type}:${base.subtype}`) ) return false;
    return !(maxValueCp > 0 && base.valueCp + enchantCp > maxValueCp);
  });
  if ( !fits.length ) return null;
  return fits[Math.floor(rng() * fits.length)] ?? fits[0];
}

/* -------------------------------------------- */
/*  Loading documents                           */
/* -------------------------------------------- */

/** Session caches. A world's packs do not change without a reload. */
let baseCache = null;
/** The templates the last pool expansion found something to make from, for the manager's picker. */
let lastTemplates = [];
let templateCache = new Map();
let spellCache = null;

/**
 * Every DMG template in the world's compendiums that something can be made from, by name.
 * @param {object[]} pool  From `item-index.mjs#itemPool`; expanded here if it has not been.
 * @returns {Promise<{uuid: string, name: string, packLabel: string}[]>}
 */
export async function templateCatalogue(pool) {
  await expandPool(pool);
  const seen = new Set();
  return lastTemplates
    .filter(t => (seen.has(t.uuid) ? false : seen.add(t.uuid)))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang) || a.packLabel.localeCompare(b.packLabel));
}

/**
 * How many uuids the template cache has checked, how many documents it holds, and how many of
 * those are not hollow templates at all (which should be none). Exposed for the harness's memory
 * suite.
 * @returns {{checked: number, held: number, stray: number}}
 */
export function templateCacheStats() {
  let held = 0;
  let stray = 0;
  for ( const doc of templateCache.values() ) {
    if ( !doc ) continue;
    held++;
    if ( !isHollowTemplate(doc) ) stray++;
  }
  return { checked: templateCache.size, held, stray };
}

/** Drop every cache. Exposed for the harness, which enables packs mid-session. */
export function clearEnchantCaches() {
  baseCache = null;
  templateCache = new Map();
  spellCache = null;
}

/**
 * Load documents by uuid, a pack at a time.
 *
 * One `getDocuments` per pack rather than one `fromUuid` per item: loading two hundred templates one
 * round trip at a time is slow enough for a GM to notice on the first Generate.
 * @param {string[]} uuids
 * @returns {Promise<Map<string, object>>}  uuid -> document; unresolvable uuids are absent.
 */
export async function loadByUuid(uuids) {
  const out = new Map();
  const byPack = new Map();
  for ( const uuid of new Set(uuids) ) {
    const parts = String(uuid).split(".");
    if ( parts[0] !== "Compendium" || parts.length < 5 ) {
      const doc = await fromUuid(uuid).catch(() => null);
      if ( doc ) out.set(uuid, doc);
      continue;
    }
    const pack = `${parts[1]}.${parts[2]}`;
    if ( !byPack.has(pack) ) byPack.set(pack, []);
    byPack.get(pack).push({ uuid, id: parts[4] });
  }
  for ( const [collection, entries] of byPack ) {
    const pack = game.packs.get(collection);
    if ( !pack ) continue;
    try {
      const docs = await pack.getDocuments({ _id__in: entries.map(e => e.id) });
      const byId = new Map(docs.map(d => [d.id, d]));
      for ( const { uuid, id } of entries ) if ( byId.has(id) ) out.set(uuid, byId.get(id));
    } catch ( err ) {
      log(`could not load documents from ${collection}`, err);
    }
  }
  return out;
}

/**
 * The system's own base items — every weapon, armour, shield and ammunition dnd5e names in
 * `CONFIG.DND5E.weaponIds`, `armorIds`, `shieldIds` and `ammoIds`. The system swaps those tables for
 * the 2014 items under legacy rules, so a world gets the Longsword that matches its rules.
 * @returns {Promise<(BaseSummary & {doc: object})[]>}
 */
export async function baseItems() {
  if ( baseCache ) return baseCache;
  const config = globalThis.CONFIG?.DND5E ?? {};
  const itemsPack = config.sourcePacks?.ITEMS;
  const uuids = ["weaponIds", "armorIds", "shieldIds", "ammoIds"]
    .flatMap(table => Object.values(config[table] ?? {}))
    .filter(v => typeof v === "string" && v)
    .map(v => (v.includes(".") ? v : `Compendium.${itemsPack}.Item.${v}`));
  const docs = await loadByUuid(uuids);
  baseCache = [...docs.entries()].map(([uuid, doc]) => ({
    uuid,
    name: doc.name,
    img: doc.img,
    type: doc.type,
    subtype: typeof doc.system?.type?.value === "string" ? doc.system.type.value : "",
    properties: listOf(doc.system?.properties),
    valueCp: itemValueCp(doc.system?.price),
    doc
  })).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  return baseCache;
}

/**
 * Load a template and describe what can be made from it: each enchantment with the bases it fits.
 * Empty for anything that is not a hollow template.
 * @param {object|string} template  A document or a uuid.
 * @returns {Promise<{template: object, uuid: string, choices: {profile: EnchantProfile, bases: BaseSummary[]}[]}>}
 */
export async function templateChoices(template) {
  const doc = typeof template === "string" ? await fromUuid(template).catch(() => null) : template;
  const uuid = doc?.uuid ?? "";
  if ( !doc || !isHollowTemplate(doc) ) return { template: doc, uuid, choices: [] };
  const bases = await baseItems();
  const choices = enchantProfiles(doc)
    .map(profile => ({ profile, bases: eligibleBases(profile, baseTypeFor(profile, doc), bases) }))
    .filter(choice => choice.bases.length);
  return { template: doc, uuid, choices };
}

/**
 * Build a finished enchanted item's data.
 * @param {object} params
 * @param {object|string} params.template     Document or uuid.
 * @param {string} params.profileKey          From {@link EnchantProfile.key}.
 * @param {string} params.baseUuid
 * @returns {Promise<object|null>}  Creation data, or null if any part cannot be found or does not fit.
 */
export async function makeEnchantedData({ template, profileKey, baseUuid }) {
  const { template: doc, uuid, choices } = await templateChoices(template);
  const choice = choices.find(c => c.profile.key === profileKey);
  const base = choice?.bases.find(b => b.uuid === baseUuid);
  if ( !doc || !choice || !base ) return null;
  return enchantedItemData({
    base: base.doc.toObject(),
    baseUuid: base.uuid,
    template: doc.toObject(),
    templateUuid: uuid,
    profile: choice.profile
  });
}

/**
 * Build a random finished item from a template: a random enchantment, on a random base that fits.
 * What a roll table or an API call gets, where nobody is there to choose.
 * @param {object|string} template
 * @param {object} [options]
 * @param {() => number} [options.rng]
 * @param {string[]} [options.categories]
 * @param {number} [options.maxValueCp]
 * @param {string} [options.profileKey]  Restrict to this enchantment.
 * @returns {Promise<object|null>}
 */
export async function makeRandomEnchantedData(template, { rng = Math.random, categories = [], maxValueCp = 0, profileKey } = {}) {
  const { template: doc, uuid, choices } = await templateChoices(template);
  const usable = choices.filter(c => !profileKey || c.profile.key === profileKey);
  // Tried in a random order, so a ceiling that excludes one enchantment falls through to another.
  const order = [...usable].sort(() => rng() - 0.5);
  for ( const { profile, bases } of order ) {
    const enchantCp = enchantmentValueCp({
      profile, templateValueCp: itemValueCp(doc.system?.price), consumable: baseTypeFor(profile, doc) === "consumable"
    });
    const base = pickBase({ eligible: bases, categories, maxValueCp, enchantCp, rng });
    if ( !base ) continue;
    return enchantedItemData({
      base: base.doc.toObject(), baseUuid: base.uuid, template: doc.toObject(), templateUuid: uuid, profile
    });
  }
  return null;
}

/* -------------------------------------------- */
/*  Scrolls                                     */
/* -------------------------------------------- */

/**
 * The blank spell scroll items dnd5e keys by level, which are not worth stocking on their own.
 * @returns {Map<number, string>}  level -> uuid.
 */
export function blankScrollUuids() {
  const config = globalThis.CONFIG?.DND5E ?? {};
  const itemsPack = config.sourcePacks?.ITEMS;
  const out = new Map();
  for ( const [level, value] of Object.entries(config.spellScrollIds ?? {}) ) {
    if ( typeof value !== "string" || !value ) continue;
    out.set(Number(level), value.includes(".") ? value : `Compendium.${itemsPack}.Item.${value}`);
  }
  return out;
}

/**
 * Every spell the world can see, by level, from the system's compendium browser.
 * @returns {Promise<Map<number, {uuid: string, name: string}[]>>}
 */
export async function spellsByLevel() {
  if ( spellCache ) return spellCache;
  const browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
  const index = browser?.fetch ? await browser.fetch(Item, {
    types: new Set(["spell"]), indexFields: new Set(["system.level"]), index: true
  }).catch(() => []) : [];
  spellCache = new Map();
  for ( const entry of index ) {
    const level = Number(entry.system?.level);
    if ( !Number.isInteger(level) || !entry.uuid ) continue;
    if ( !spellCache.has(level) ) spellCache.set(level, []);
    spellCache.get(level).push({ uuid: entry.uuid, name: entry.name });
  }
  return spellCache;
}

/**
 * A finished spell scroll's data, made by dnd5e itself.
 * @param {object|string} spell  A spell document or its uuid.
 * @returns {Promise<object|null>}
 */
export async function makeScrollData(spell) {
  const doc = typeof spell === "string" ? await fromUuid(spell).catch(() => null) : spell;
  if ( doc?.type !== "spell" ) return null;
  const scroll = await Item.implementation.createScrollFromSpell(doc, {}, { dialog: false }).catch(err => {
    log(`could not make a scroll of "${doc.name}"`, err);
    return null;
  });
  if ( !scroll ) return null;
  const data = scroll.toObject();
  delete data._id;
  data.flags = { ...data.flags, [MODULE_ID]: { ...data.flags?.[MODULE_ID], madeFrom: { spell: doc.uuid } } };
  return data;
}

/**
 * The generator pool entries scrolls contribute: a few per spell level the world has spells for,
 * valued and rarity-banded by dnd5e's own blank scroll of that level.
 * @returns {Promise<object[]>}
 */
export async function scrollEntries() {
  const blanks = blankScrollUuids();
  const spells = await spellsByLevel();
  const docs = await loadByUuid([...blanks.values()]);
  const out = [];
  for ( const [level, uuid] of blanks ) {
    const blank = docs.get(uuid);
    if ( !blank || !spells.get(level)?.length ) continue;
    for ( let n = 0; n < SCROLLS_PER_LEVEL; n++ ) {
      out.push({
        kind: "scroll",
        level,
        uuid,
        key: `scroll:${level}:${n}`,
        name: blank.name,
        img: blank.img,
        type: "consumable",
        subtype: "scroll",
        rarity: normalizeRarity(blank.system?.rarity),
        valueCp: itemValueCp(blank.system?.price),
        pack: "",
        packLabel: ""
      });
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  The generator's pool                        */
/* -------------------------------------------- */

/** Item types a hollow template can be. Checked on the index before any document is loaded. */
const TEMPLATE_TYPES = new Set(["weapon", "equipment", "consumable"]);

/**
 * Whether an index entry might be a hollow template, from what the index alone can tell: magical,
 * of a type the DMG templates use, and missing a subtype or a price. Only these are loaded.
 * @param {object} entry  A pool entry.
 * @returns {boolean}
 */
export function mightBeTemplate(entry) {
  return TEMPLATE_TYPES.has(entry?.type) && (entry.properties ?? []).includes("mgc")
    && (!entry.subtype || entry.valueCp <= 0);
}

/**
 * The stock generator's pool: the compendium pool with hollow templates and blank scrolls swapped
 * for what can really be made from them.
 * @param {object[]} pool  From `item-index.mjs#itemPool`.
 * @returns {Promise<object[]>}
 */
export async function expandPool(pool) {
  lastTemplates = [];
  const candidates = pool.filter(mightBeTemplate);
  const bases = candidates.length ? await baseItems() : [];
  const missing = candidates.map(e => e.uuid).filter(uuid => !templateCache.has(uuid));
  if ( missing.length ) {
    // Only a hollow template is kept. Most candidates are finished magic items the index could not
    // rule out, and holding their whole documents for the session pins them in memory long after
    // Foundry's own compendium cache would have let them go. A null still records "looked, not one".
    const docs = await loadByUuid(missing);
    for ( const uuid of missing ) {
      const doc = docs.get(uuid);
      templateCache.set(uuid, doc && isHollowTemplate(doc) ? doc : null);
    }
  }

  const replaced = new Set();
  const made = [];
  for ( const entry of candidates ) {
    const doc = templateCache.get(entry.uuid);
    if ( !doc ) continue;
    const entries = templateEntries({ template: doc, uuid: entry.uuid, pack: entry.pack, packLabel: entry.packLabel, bases });
    replaced.add(entry.uuid);
    made.push(...entries);
    if ( entries.length ) lastTemplates.push({ uuid: entry.uuid, name: doc.name, packLabel: entry.packLabel });
  }

  const blanks = new Set(blankScrollUuids().values());
  const scrolls = await scrollEntries();
  const isBlank = entry => blanks.has(entry.uuid) || /^spell-scroll/.test(entry.identifier ?? "");

  return [
    ...pool.filter(entry => !replaced.has(entry.uuid) && !(scrolls.length && isBlank(entry))),
    ...made,
    ...scrolls
  ];
}

/**
 * Turn picked generator entries into things to stock: plain uuids for ordinary items, finished item
 * data for templates and scrolls.
 * @param {object[]} picked
 * @param {object} [options]
 * @param {string[]} [options.categories]
 * @param {number} [options.maxValueCp]
 * @param {() => number} [options.rng]
 * @returns {Promise<{uuids: string[], data: object[], failed: string[]}>}
 */
export async function materialise(picked, { categories = [], maxValueCp = 0, rng = Math.random } = {}) {
  const uuids = [];
  const data = [];
  const failed = [];
  const usedSpells = new Set();

  for ( const entry of picked ?? [] ) {
    if ( entry.kind === "enchant" ) {
      const made = await makeRandomEnchantedData(templateCache.get(entry.uuid) ?? entry.uuid, {
        rng, categories, maxValueCp, profileKey: entry.profileKey
      });
      if ( made ) data.push(made);
      else failed.push(entry.key);
    } else if ( entry.kind === "scroll" ) {
      const spells = ((await spellsByLevel()).get(entry.level) ?? []).filter(s => !usedSpells.has(s.uuid));
      const spell = spells[Math.floor(rng() * spells.length)];
      const made = spell ? await makeScrollData(spell.uuid) : null;
      if ( made ) {
        usedSpells.add(spell.uuid);
        data.push(made);
      } else failed.push(entry.key);
    } else {
      uuids.push(entry.uuid);
    }
  }
  return { uuids, data, failed };
}
