import { PHYSICAL_TYPES, log, normalizeRarity } from "../config.mjs";
import { itemValueCp } from "./pricing.mjs";

/**
 * The pool of stockable items across every compendium the world can see.
 *
 * Built on the system's own `CompendiumBrowser.fetch`, which already knows how to walk every
 * visible pack, honour the GM's compendium-source settings, skip items inside containers, and
 * return a lean index rather than full documents. Reimplementing that would mean duplicating
 * four separate correctness decisions the system has already made.
 *
 * The result feeds the **generator** (`data/generate.mjs`). The GM's *manual* picking goes
 * through `CompendiumBrowser.select()` instead — the system's real browser, with its search,
 * type tabs, rarity and price filters — because a hand-rolled picker could only ever be a worse
 * version of a window dnd5e already ships.
 */

/** Index fields the pool needs beyond name/img/type, which every index carries anyway. */
const INDEX_FIELDS = new Set([
  "system.price", "system.rarity", "system.type", "system.quantity",
  // Both small, and both needed to tell a DMG magic item template or a blank spell scroll from the
  // finished article without loading every document — see `data/enchant.mjs#mightBeTemplate`.
  "system.properties", "system.identifier"
]);

/**
 * Session cache. Fetching every physical item across a dozen content packs takes a noticeable
 * moment, and the answer does not change while a world is open — enabling a module requires a
 * reload, which empties this along with everything else.
 * @type {{entries: object[], at: number}|null}
 */
let cache = null;

/** Drop the cache. Exposed for the e2e harness, which enables packs mid-session. */
export function clearIndexCache() {
  cache = null;
}

/**
 * @typedef {object} PoolEntry
 * @property {string} uuid
 * @property {string} name
 * @property {string} img
 * @property {string} type       dnd5e item type.
 * @property {string} subtype    The system's `system.type.value`, or "" — this is what makes
 *                               "armour" and "musical instrument" expressible, since neither is
 *                               an item *type* in dnd5e (they are subtypes of equipment and
 *                               tool respectively).
 * @property {string} rarity     Normalised, or "" for mundane gear.
 * @property {number} valueCp    List value in copper; 0 means unpriced.
 * @property {string} pack       Collection id of the pack it came from.
 * @property {string} packLabel  The pack's title, for the GM's source filter.
 * @property {string[]} properties  The item's property keys ("mgc" for magical).
 * @property {string} identifier    The system's `system.identifier`, or "".
 */

/**
 * Every stockable item the world can see, as a flat pool.
 *
 * Unpriced items are kept rather than dropped: the generator excludes them (it cannot budget
 * something with no value), but the pool is also what the "how much is out there" counts in the
 * generator panel are drawn from, and silently omitting a third of a pack would make those
 * counts lie.
 * @param {object} [options]
 * @param {boolean} [options.refresh]  Rebuild even if cached.
 * @returns {Promise<PoolEntry[]>}
 */
export async function itemPool({ refresh = false } = {}) {
  if ( cache && !refresh ) return cache.entries;

  const browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
  if ( !browser?.fetch ) {
    // Only reachable on a system version whose browser has moved or gone. Better an empty
    // generator that says so than a thrown error from inside a render.
    log("the dnd5e compendium browser is unavailable; the item pool is empty");
    return [];
  }

  const index = await browser.fetch(Item, {
    types: new Set(PHYSICAL_TYPES),
    indexFields: INDEX_FIELDS,
    index: true,
    sort: "name"
  }).catch(err => {
    log("compendium fetch failed", err);
    return [];
  });

  const entries = index.map(entry => toPoolEntry(entry)).filter(Boolean);
  cache = { entries, at: Date.now() };
  log(`item pool built: ${entries.length} stockable items`);
  return entries;
}

/**
 * Shape one index entry into a pool entry, or null if it is unusable.
 * @param {object} entry
 * @returns {PoolEntry|null}
 */
function toPoolEntry(entry) {
  if ( !entry?.uuid || !entry.name ) return null;
  const pack = packOf(entry.uuid);
  return {
    uuid: entry.uuid,
    name: entry.name,
    img: entry.img ?? "icons/svg/item-bag.svg",
    type: entry.type,
    subtype: typeof entry.system?.type?.value === "string" ? entry.system.type.value : "",
    rarity: normalizeRarity(entry.system?.rarity),
    valueCp: itemValueCp(entry.system?.price),
    pack,
    packLabel: game.packs.get(pack)?.title ?? pack,
    properties: [...(entry.system?.properties ?? [])].filter(p => typeof p === "string"),
    identifier: typeof entry.system?.identifier === "string" ? entry.system.identifier : ""
  };
}

/**
 * The pack collection id from a compendium uuid.
 *
 * `Compendium.<package>.<pack>.Item.<id>` — so the collection is the two segments after the
 * prefix. Parsed by hand rather than with `foundry.utils.parseUuid` because this runs once per
 * item over tens of thousands of them, and the parser allocates an object for each.
 * @param {string} uuid
 * @returns {string}
 */
function packOf(uuid) {
  const parts = uuid.split(".");
  return parts[0] === "Compendium" ? `${parts[1]}.${parts[2]}` : "";
}

/**
 * The packs the pool actually drew from, for the generator's source picker.
 *
 * Derived from the pool rather than from `game.packs` so the list only ever offers sources that
 * contain something stockable — a GM should not be able to tick a pack of spells and wonder why
 * nothing generated.
 * @param {PoolEntry[]} pool
 * @returns {{id: string, label: string, count: number}[]}
 */
export function poolSources(pool) {
  const counts = new Map();
  for ( const entry of pool ) {
    if ( !entry.pack ) continue;
    const existing = counts.get(entry.pack);
    if ( existing ) existing.count++;
    else counts.set(entry.pack, { id: entry.pack, label: entry.packLabel, count: 1 });
  }
  return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/**
 * How many priced items the pool holds at each rarity, for the generator's "out of N available"
 * readouts. Mundane gear is counted under `""`.
 * @param {PoolEntry[]} pool
 * @returns {Record<string, number>}
 */
export function poolCounts(pool) {
  const counts = {};
  for ( const entry of pool ) {
    if ( entry.valueCp <= 0 ) continue;
    counts[entry.rarity] = (counts[entry.rarity] ?? 0) + 1;
  }
  return counts;
}
