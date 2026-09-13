import { MODULE_ID, PHYSICAL_TYPES, SETTINGS, DEFAULTS, log, setting, t } from "../config.mjs";
import { clampAttitude } from "./attitude.mjs";
import { BUDGET_KEYS, sanitizeBudget } from "./generate.mjs";
import { RESTOCK_MODES, sanitizeRestock } from "./restock.mjs";
import { sanitizeBuyFilter } from "./stock.mjs";

/**
 * Archetypes: a shop's whole character in one choice — "Blacksmith", "Apothecary", "Fence".
 *
 * The Trader Manager has every knob a GM could want, and no starting point. An archetype is that
 * starting point: what the shop stocks (a generator **recipe**), what it will buy (a **buy
 * filter**), how it feels about strangers (a **starting attitude**), and how often its shelves
 * refill (a **restock** rule). Applying one sets all four in a click; applying it "with stock"
 * also fills the shelves from the recipe.
 *
 * Two kinds, with one shape:
 *
 *  - **Built-in** archetypes ship with the module ({@link BUILT_IN_ARCHETYPES}). Their names are
 *    localisation keys, and they never name a compendium, because no world is guaranteed to have
 *    any particular one.
 *  - **Saved** archetypes are the GM's own, taken from a Trader they have already set up. They
 *    live in a world setting and *may* name compendium packs, since they never leave the world
 *    they were saved in.
 *
 * What an archetype deliberately does **not** carry: stock itself (that is what export is for —
 * see `data/portable.mjs`), a purse, a greeting, or anybody's attitude. It describes a *kind* of
 * shop, and every one of those belongs to a particular shop.
 *
 * The pure half is at the top; the world-setting store is at the bottom, below its banner.
 */

/**
 * @typedef {object} Recipe
 * @property {Record<string, number>} budget  Items per rarity bucket, as the generator takes it.
 * @property {string[]} categories            Category tokens (`"weapon"`, `"equipment:heavy"`).
 * @property {number} maxValueCp              Price ceiling in copper; 0 means none.
 * @property {string[]} packs                 Pack collection ids; empty means every pack.
 */

/**
 * @typedef {object} Archetype
 * @property {string} id
 * @property {string} name                A label, or for a built-in a localisation key.
 * @property {string} hint                A one-line description, same rule.
 * @property {string} icon                A Font Awesome class.
 * @property {boolean} builtIn
 * @property {Recipe} recipe
 * @property {object} buyFilter           As `data/stock.mjs#sanitizeBuyFilter` returns it.
 * @property {number|null} startingAttitude  Null leaves the Trader's own untouched.
 * @property {{mode: string, days: number}} restock
 */

/** The prefix every built-in id carries, so a saved archetype can never collide with one. */
export const BUILT_IN_PREFIX = "builtin-";

/** The most archetypes a world may save. A limit on a list nobody should be scrolling. */
export const SAVED_LIMIT = 50;

/** The localisation key for a built-in's field. */
const key = (id, field) => `${MODULE_ID}.archetype.builtIn.${id}.${field}`;

/**
 * A built-in archetype, from its short id and its settings.
 *
 * Every budget lists all its buckets explicitly — zeroes included — so reading one tells a GM
 * exactly what it asks for rather than leaving them to wonder what an absent key defaults to.
 */
function builtIn(id, { icon, recipe, buyFilter, startingAttitude = null, restock }) {
  return Object.freeze(sanitizeArchetype({
    id: `${BUILT_IN_PREFIX}${id}`,
    name: key(id, "name"),
    hint: key(id, "hint"),
    icon,
    builtIn: true,
    recipe,
    buyFilter,
    startingAttitude,
    restock
  }, { builtIn: true }));
}

/**
 * The archetypes the module ships.
 *
 * Categories are dnd5e 6's own type and subtype keys — `equipment:heavy` is heavy armour,
 * `tool:music` an instrument — because the generator matches on exactly those. A category no
 * enabled compendium happens to contain costs nothing: the generator reports the shortfall and
 * stocks what it could find.
 *
 * Price ceilings keep a "Blacksmith" from producing a 20,000 gp vorpal blade on its first click,
 * which is the one outcome that would make a GM stop trusting the button.
 */
export const BUILT_IN_ARCHETYPES = Object.freeze([
  builtIn("general", {
    icon: "fa-solid fa-basket-shopping",
    recipe: {
      budget: { "": 24, common: 4, uncommon: 1, rare: 0, veryrare: 0, legendary: 0, artifact: 0 },
      categories: [],
      maxValueCp: 5_000
    },
    buyFilter: { allowAll: true },
    restock: { mode: "time", days: 7 }
  }),
  builtIn("blacksmith", {
    icon: "fa-solid fa-hammer",
    recipe: {
      budget: { "": 16, common: 2, uncommon: 2, rare: 0, veryrare: 0, legendary: 0, artifact: 0 },
      categories: [
        "weapon", "equipment:light", "equipment:medium", "equipment:heavy", "equipment:shield",
        "consumable:ammo"
      ],
      maxValueCp: 200_000
    },
    buyFilter: { allowAll: false, types: ["weapon", "equipment"], rarities: [] },
    restock: { mode: "time", days: 7 }
  }),
  builtIn("apothecary", {
    icon: "fa-solid fa-flask",
    recipe: {
      budget: { "": 6, common: 6, uncommon: 3, rare: 1, veryrare: 0, legendary: 0, artifact: 0 },
      categories: ["consumable:potion", "consumable:poison", "loot:material"],
      maxValueCp: 100_000
    },
    buyFilter: { allowAll: false, types: ["consumable", "loot"], rarities: [] },
    restock: { mode: "time", days: 3 }
  }),
  builtIn("outfitter", {
    icon: "fa-solid fa-compass",
    recipe: {
      budget: { "": 22, common: 2, uncommon: 0, rare: 0, veryrare: 0, legendary: 0, artifact: 0 },
      categories: ["tool", "container", "loot:gear", "equipment:clothing", "consumable:food"],
      maxValueCp: 10_000
    },
    buyFilter: { allowAll: false, types: ["tool", "container", "loot", "equipment"], rarities: [] },
    restock: { mode: "time", days: 7 }
  }),
  builtIn("arcanist", {
    icon: "fa-solid fa-wand-sparkles",
    recipe: {
      budget: { "": 0, common: 4, uncommon: 4, rare: 2, veryrare: 1, legendary: 0, artifact: 0 },
      categories: [
        "consumable:scroll", "consumable:wand", "equipment:wand", "equipment:rod",
        "equipment:ring", "equipment:wondrous"
      ],
      maxValueCp: 5_000_000
    },
    // An arcanist has no use for a bent sword: it buys magic, of any kind.
    buyFilter: {
      allowAll: false,
      types: [],
      rarities: ["common", "uncommon", "rare", "veryrare", "legendary", "artifact"]
    },
    // A little guarded with strangers. Their best stock is worth earning.
    startingAttitude: 40,
    restock: { mode: "manual", days: 7 }
  }),
  builtIn("jeweller", {
    icon: "fa-solid fa-gem",
    recipe: {
      budget: { "": 10, common: 3, uncommon: 2, rare: 1, veryrare: 0, legendary: 0, artifact: 0 },
      categories: ["loot:gem", "loot:art", "loot:treasure", "equipment:ring", "equipment:trinket"],
      maxValueCp: 500_000
    },
    buyFilter: { allowAll: false, types: ["loot", "equipment"], rarities: [] },
    restock: { mode: "time", days: 14 }
  }),
  builtIn("fence", {
    icon: "fa-solid fa-mask",
    recipe: {
      budget: { "": 8, common: 4, uncommon: 3, rare: 1, veryrare: 0, legendary: 0, artifact: 0 },
      categories: [],
      maxValueCp: 500_000
    },
    // A fence buys anything, which is the point of one — and trusts nobody until paid to.
    buyFilter: { allowAll: true },
    startingAttitude: 30,
    restock: { mode: "time", days: 14 }
  })
]);

/* -------------------------------------------- */
/*  Guarding                                    */
/* -------------------------------------------- */

/**
 * Whether a string is a category token the generator can match: a physical item type, optionally
 * followed by `:` and a subtype key.
 * @param {*} token
 * @returns {boolean}
 */
export function validCategory(token) {
  if ( typeof token !== "string" ) return false;
  const [type, subtype, ...rest] = token.split(":");
  if ( rest.length || !PHYSICAL_TYPES.includes(type) ) return false;
  return subtype === undefined || /^[A-Za-z0-9]+$/.test(subtype);
}

/**
 * Guard a stock recipe.
 * @param {*} raw
 * @returns {Recipe}
 */
export function sanitizeRecipe(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const max = Math.round(Number(r.maxValueCp) || 0);
  const strings = value => [...new Set((Array.isArray(value) ? value : [])
    .filter(v => typeof v === "string" && v))];
  return {
    budget: sanitizeBudget(r.budget),
    categories: strings(r.categories).filter(validCategory),
    maxValueCp: max > 0 ? max : 0,
    packs: strings(r.packs)
  };
}

/**
 * Guard an archetype, stored or built-in.
 *
 * `builtIn` is decided by the caller, never by the data: a saved archetype that claimed to be
 * built in would otherwise become undeletable from the manager.
 * @param {*} raw
 * @param {object} [options]
 * @param {boolean} [options.builtIn]
 * @returns {Archetype|null}  Null for something with no id or no name.
 */
export function sanitizeArchetype(raw, { builtIn: isBuiltIn = false } = {}) {
  if ( !raw || typeof raw !== "object" ) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if ( !id || !name ) return null;
  // A saved archetype may not borrow the built-in prefix, or it could shadow one.
  if ( !isBuiltIn && id.startsWith(BUILT_IN_PREFIX) ) return null;

  const restock = sanitizeRestock(raw.restock);
  const attitude = raw.startingAttitude;
  return {
    id,
    name,
    hint: typeof raw.hint === "string" ? raw.hint : "",
    icon: typeof raw.icon === "string" && raw.icon ? raw.icon : "fa-solid fa-shop",
    builtIn: isBuiltIn,
    // Saved archetypes may name packs; built-ins never do, whatever their data says.
    recipe: isBuiltIn ? { ...sanitizeRecipe(raw.recipe), packs: [] } : sanitizeRecipe(raw.recipe),
    buyFilter: sanitizeBuyFilter(raw.buyFilter),
    startingAttitude: attitude === null || attitude === undefined || attitude === ""
      || !Number.isFinite(Number(attitude)) ? null : clampAttitude(attitude),
    restock: { mode: restock.mode, days: restock.days }
  };
}

/* -------------------------------------------- */
/*  Working with archetypes                     */
/* -------------------------------------------- */

/**
 * An archetype taken from a Trader's current setup, ready to save.
 *
 * The recipe comes from the caller rather than the Trader, because a Trader does not store how
 * its stock was generated — the manager's generator panel holds that, and saving "this Trader as
 * an archetype" means saving what the GM has in front of them.
 *
 * The starting attitude is always recorded, even when it is the world default: a GM saving a
 * shop is saying "shops like this one", and "like this one" includes how it greets strangers.
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.name
 * @param {object} params.data    From `data/trader.mjs#traderData`.
 * @param {Recipe} [params.recipe]
 * @param {string} [params.icon]
 * @returns {Archetype|null}
 */
export function archetypeFromTrader({ id, name, data, recipe, icon }) {
  return sanitizeArchetype({
    id,
    name,
    icon,
    recipe,
    buyFilter: data?.buyFilter,
    startingAttitude: data?.startingAttitude,
    restock: data?.restock
  });
}

/**
 * The flag writes that apply an archetype to a Trader, as an `Actor#update` payload.
 *
 * Dotted paths rather than a whole flag object, so what the archetype does not describe — the
 * greeting, stored attitudes, the ledger, and the restock clock's `lastAt` — is left exactly as
 * it was. Changing a Blacksmith into an Apothecary must not make it forget the party.
 * @param {Archetype} archetype
 * @returns {Record<string, *>}
 */
export function archetypeUpdate(archetype) {
  const a = sanitizeArchetype(archetype, { builtIn: !!archetype?.builtIn });
  if ( !a ) return {};
  const base = `flags.${MODULE_ID}`;
  const update = {
    [`${base}.buyFilter`]: a.buyFilter,
    [`${base}.restock.mode`]: a.restock.mode,
    [`${base}.restock.days`]: a.restock.days
  };
  if ( a.startingAttitude !== null ) update[`${base}.startingAttitude`] = a.startingAttitude;
  return update;
}

/**
 * The generator panel state an archetype's recipe corresponds to, in the shape the Trader
 * Manager holds it — so applying an archetype leaves the generator primed to run it again.
 * @param {Recipe} recipe
 * @param {(cp: number) => {value: number, denomination: string}} toParts  Copper to a price input.
 * @returns {{budget: object, categories: string[], packs: string[], maxValue: string|number, maxDenom: string}}
 */
export function recipeToGenerator(recipe, toParts) {
  const r = sanitizeRecipe(recipe);
  const parts = r.maxValueCp > 0 ? toParts(r.maxValueCp) : null;
  return {
    budget: { ...r.budget },
    categories: [...r.categories],
    packs: [...r.packs],
    maxValue: parts ? parts.value : "",
    maxDenom: parts ? parts.denomination : "gp"
  };
}

/**
 * The non-zero buckets of a recipe's budget, in bucket order, for a one-line summary.
 * @param {Recipe} recipe
 * @returns {[string, number][]}  `[bucketKey, count]`, where `""` is mundane gear.
 */
export function budgetSummary(recipe) {
  const budget = sanitizeRecipe(recipe).budget;
  return BUDGET_KEYS.filter(k => budget[k] > 0).map(k => [k, budget[k]]);
}

/** Whether an id belongs to a built-in archetype. */
export function isBuiltIn(id) {
  return typeof id === "string" && id.startsWith(BUILT_IN_PREFIX);
}

/** The restock modes, re-exported for the manager's summary line. */
export { RESTOCK_MODES };

/* -------------------------------------------- */
/*  The saved archetypes (GM-side)              */
/* -------------------------------------------- */

/**
 * The GM's saved archetypes, guarded.
 * @returns {Archetype[]}
 */
export function savedArchetypes() {
  const raw = setting(SETTINGS.archetypes) ?? DEFAULTS.archetypes;
  const list = Array.isArray(raw?.list) ? raw.list : [];
  const seen = new Set();
  const out = [];
  for ( const entry of list ) {
    const archetype = sanitizeArchetype(entry);
    if ( !archetype || seen.has(archetype.id) ) continue;
    seen.add(archetype.id);
    out.push(archetype);
  }
  return out;
}

/**
 * Every archetype: the built-ins in their shipped order, then the saved ones by name.
 * @returns {Archetype[]}
 */
export function listArchetypes() {
  const saved = savedArchetypes().sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILT_IN_ARCHETYPES, ...saved];
}

/**
 * One archetype by id, or null.
 * @param {string} id
 * @returns {Archetype|null}
 */
export function getArchetype(id) {
  return listArchetypes().find(a => a.id === id) ?? null;
}

/**
 * Save an archetype, replacing one with the same id.
 * @param {Archetype} archetype
 * @returns {Promise<Archetype>}
 * @throws {Error}  For a built-in id, a malformed archetype, or a full list.
 */
export async function saveArchetype(archetype) {
  const clean = sanitizeArchetype(archetype);
  if ( !clean ) throw new Error(t("error.archetypeInvalid"));
  const list = savedArchetypes().filter(a => a.id !== clean.id);
  if ( list.length >= SAVED_LIMIT ) {
    throw new Error(t("error.archetypeLimit", { limit: SAVED_LIMIT }));
  }
  list.push(clean);
  await game.settings.set(MODULE_ID, SETTINGS.archetypes, { list });
  log(`archetype saved: "${clean.name}" (${clean.id})`);
  return clean;
}

/**
 * Delete a saved archetype. A built-in cannot be deleted, and asking is not an error.
 * @param {string} id
 * @returns {Promise<boolean>}  Whether anything was removed.
 */
export async function deleteArchetype(id) {
  if ( isBuiltIn(id) ) return false;
  const list = savedArchetypes();
  const next = list.filter(a => a.id !== id);
  if ( next.length === list.length ) return false;
  await game.settings.set(MODULE_ID, SETTINGS.archetypes, { list: next });
  return true;
}
