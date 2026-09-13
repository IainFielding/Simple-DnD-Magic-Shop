import { RARITIES, log } from "../config.mjs";

/**
 * Stocking a shop by the handful: "three uncommon, one rare, twenty mundane", or a roll table.
 *
 * The selection itself ({@link pickByBudget}) is pure, with the random source injected, so the
 * generator is unit-testable and a seeded run is reproducible. Only {@link rollTableStock} needs
 * Foundry, because drawing from a RollTable is Foundry's job.
 */

/** The rarity buckets a budget can name. `""` is mundane gear — items with no rarity. */
export const BUDGET_KEYS = ["", ...RARITIES];

/**
 * A sensible general store: plenty of ordinary gear, a few interesting things, nothing absurd.
 * Deliberately weighted toward the bottom — a shop where every shelf holds a legendary is not a
 * shop, and a GM who wants one can say so.
 */
export function defaultBudget() {
  return { "": 20, common: 6, uncommon: 3, rare: 1, veryrare: 0, legendary: 0, artifact: 0 };
}

/**
 * Guard a budget from the generator form.
 * @param {*} raw
 * @returns {Record<string, number>}
 */
export function sanitizeBudget(raw) {
  const budget = {};
  for ( const key of BUDGET_KEYS ) {
    const n = Number(raw?.[key]);
    // Capped per bucket: a mistyped 1000 would otherwise create a thousand embedded documents
    // and hang the client mid-render.
    budget[key] = Number.isFinite(n) && n > 0 ? Math.min(200, Math.round(n)) : 0;
  }
  return budget;
}

/** Whether a budget asks for anything at all. */
export function budgetTotal(budget) {
  return Object.values(sanitizeBudget(budget)).reduce((sum, n) => sum + n, 0);
}

/* -------------------------------------------- */
/*  Selection (pure)                            */
/* -------------------------------------------- */

/**
 * Narrow a pool to what a generation run may draw from.
 *
 * Unpriced items are always excluded: the whole premise is a shop that sells things, and an
 * item with no value and no override cannot be sold. A price ceiling is the other common need —
 * without one, asking for "1 rare" can hand back a 200,000 gp staff and unbalance a campaign in
 * a single click.
 * @param {import("./item-index.mjs").PoolEntry[]} pool
 * @param {object} [options]
 * @param {string[]} [options.packs]      Restrict to these pack collection ids; empty means all.
 * @param {number} [options.maxValueCp]   Exclude anything dearer than this.
 * @param {number} [options.minValueCp]   Exclude anything cheaper.
 * @param {string[]} [options.categories]  Restrict to these categories; empty means all.
 * @returns {import("./item-index.mjs").PoolEntry[]}
 */
export function filterPool(pool, { packs = [], maxValueCp = 0, minValueCp = 0, categories = [] } = {}) {
  const packSet = new Set(packs);
  const categorySet = new Set(categories);
  return (pool ?? []).filter(entry => {
    if ( entry.valueCp <= 0 ) return false;
    if ( packSet.size && !packSet.has(entry.pack) ) return false;
    if ( !matchesCategories(entry, categorySet) ) return false;
    if ( maxValueCp > 0 && entry.valueCp > maxValueCp ) return false;
    if ( minValueCp > 0 && entry.valueCp < minValueCp ) return false;
    return true;
  });
}

/**
 * The two category tokens an item answers to: its type, and its type-and-subtype.
 *
 * Two levels because one is not enough. dnd5e has six physical item *types*, and neither
 * "armour" nor "musical instrument" is among them — armour is `equipment` with a subtype of
 * `heavy`/`medium`/`light`/`shield`, and a lute is a `tool` with a subtype of `music`. A GM
 * asking for "some armour and a couple of instruments" cannot express that with types alone.
 * @param {import("./item-index.mjs").PoolEntry} entry
 * @returns {string[]}
 */
export function categoryTokens(entry) {
  const type = entry?.type ?? "";
  const subtype = entry?.subtype ?? "";
  return subtype ? [type, `${type}:${subtype}`] : [type];
}

/**
 * Whether an entry falls in any of the selected categories.
 *
 * Ticking a whole type means "any subtype of it", and ticking a subtype means only that one —
 * which falls out of matching on either token rather than needing two separate lists.
 * @param {import("./item-index.mjs").PoolEntry} entry
 * @param {Set<string>|string[]} categories  Empty means no restriction.
 * @returns {boolean}
 */
export function matchesCategories(entry, categories) {
  const set = categories instanceof Set ? categories : new Set(categories ?? []);
  if ( !set.size ) return true;
  return categoryTokens(entry).some(token => set.has(token));
}

/**
 * How many priced items the pool holds in each category, for the picker's counts.
 *
 * An item is counted under *both* its tokens, so a "Tools" heading and a "Musical Instrument"
 * row beneath it both read correctly — the heading is a superset, not a sibling.
 * @param {import("./item-index.mjs").PoolEntry[]} pool
 * @returns {Record<string, number>}
 */
export function categoryCounts(pool) {
  const counts = {};
  for ( const entry of pool ?? [] ) {
    if ( entry.valueCp <= 0 ) continue;
    for ( const token of categoryTokens(entry) ) counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

/**
 * Group a pool by rarity, so each bucket is drawn from independently.
 * @param {import("./item-index.mjs").PoolEntry[]} pool
 * @returns {Map<string, object[]>}
 */
export function bucketByRarity(pool) {
  const buckets = new Map(BUDGET_KEYS.map(key => [key, []]));
  for ( const entry of pool ?? [] ) {
    const bucket = buckets.get(entry.rarity);
    // A homebrew rarity the module does not know falls in with mundane gear rather than being
    // dropped — the GM put it in a pack, so it is presumably meant to be sellable.
    if ( bucket ) bucket.push(entry);
    else buckets.get("").push(entry);
  }
  return buckets;
}

/**
 * Draw a budget's worth of items from a pool.
 *
 * Each bucket is sampled **without replacement**, so a shop does not come back holding the same
 * potion six times — a GM asking for six uncommon items wants six *different* ones, and can
 * raise a quantity afterwards if they wanted a stack.
 *
 * A bucket with fewer items than the budget asks for yields everything it has and reports the
 * gap in `shortfalls`. Silently returning fewer is how a GM concludes the generator is broken
 * when what actually happened is that their enabled packs hold two legendary items.
 *
 * `rng` is injected so a test can be deterministic; the live caller passes `Math.random`.
 * @param {object} params
 * @param {import("./item-index.mjs").PoolEntry[]} params.pool
 * @param {Record<string, number>} params.budget
 * @param {() => number} [params.rng]
 * @returns {{picked: object[], shortfalls: Record<string, number>}}
 */
export function pickByBudget({ pool, budget, rng = Math.random } = {}) {
  const wanted = sanitizeBudget(budget);
  const buckets = bucketByRarity(pool);
  const picked = [];
  const shortfalls = {};

  for ( const key of BUDGET_KEYS ) {
    const count = wanted[key];
    if ( count <= 0 ) continue;
    const available = buckets.get(key) ?? [];
    const take = Math.min(count, available.length);
    if ( take < count ) shortfalls[key] = count - take;
    if ( take <= 0 ) continue;
    picked.push(...sample(available, take, rng));
  }

  return { picked, shortfalls };
}

/**
 * Take `count` distinct entries at random.
 *
 * A partial Fisher-Yates over a copy: shuffle only as far as needed, then slice. Picking
 * indices at random and retrying on a collision is the obvious alternative and degrades badly
 * when `count` approaches the pool size — asking for 19 of 20 legendary items would spend most
 * of its time rerolling.
 * @param {object[]} entries
 * @param {number} count
 * @param {() => number} rng
 * @returns {object[]}
 */
function sample(entries, count, rng) {
  const copy = [...entries];
  const take = Math.min(count, copy.length);
  for ( let i = 0; i < take; i++ ) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
}

/**
 * A seeded random source, so a generation run can be reproduced.
 *
 * mulberry32 — small, fast, and good enough for picking shop stock. Not for anything that needs
 * real randomness, which this does not.
 * @param {number} seed
 * @returns {() => number}
 */
export function seededRng(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------- */
/*  Roll tables                                 */
/* -------------------------------------------- */

/**
 * Roll a RollTable `draws` times and collect the item uuids it yields.
 *
 * Rolled with `RollTable#roll`, once per draw, rather than `draw`/`drawMany`. Both of those post
 * chat cards and, on a table without replacement, permanently mark results as drawn — generating
 * a shop's stock would quietly use up the GM's treasure table for their next real treasure roll.
 * Rolling leaves the table exactly as it was. A result that comes up twice is fine: stock is
 * merged by origin, so it simply raises that line's quantity.
 *
 * Non-item results are skipped rather than failing the run — a treasure table that also contains
 * text results ("50 gp in loose coin") is perfectly normal — so this may return fewer uuids than
 * draws, and a nested table can return more than one per draw.
 * @param {object} table   A RollTable document.
 * @param {number} draws
 * @returns {Promise<string[]>}  Item uuids.
 */
export async function rollTableStock(table, draws = 1) {
  if ( typeof table?.roll !== "function" ) return [];
  const count = Math.max(1, Math.min(100, Math.round(Number(draws) || 1)));
  const uuids = [];
  try {
    for ( let n = 0; n < count; n++ ) {
      const { results } = await table.roll({ recursive: true });
      // An empty roll means a table without replacement has nothing undrawn left; more rolls
      // would only come back empty too.
      if ( !results?.length ) break;
      for ( const result of results ) {
        const uuid = resultUuid(result);
        if ( uuid ) uuids.push(uuid);
      }
    }
  } catch ( err ) {
    log("roll table draw failed", err);
  }
  return uuids;
}

/**
 * The document uuid a table result points at, or "" for a text result.
 *
 * v13+ stores it on `documentUuid`; older tables carry `documentCollection` plus `documentId`,
 * and worlds do get upgraded in place with old tables intact.
 * @param {object} result
 * @returns {string}
 */
function resultUuid(result) {
  if ( result?.documentUuid ) return result.documentUuid;
  const collection = result?.documentCollection;
  const id = result?.documentId;
  if ( !collection || !id ) return "";
  return collection === "Item" ? `Item.${id}` : `Compendium.${collection}.Item.${id}`;
}
