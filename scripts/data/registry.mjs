import { HOOKS, MODULE_ID, SETTINGS, DEFAULTS, fireHook, log, setting, t } from "../config.mjs";
import { clearHistory, isTrader, newTraderData } from "./trader.mjs";
import { parseTraderExport } from "./portable.mjs";

/**
 * The Trader registry: which actors are Traders, and in what order the manager lists them.
 *
 * Traders are Actors, so the *authority* on which ones exist is the Actors collection — not
 * this registry. The registry stores only display order, and it heals itself on every read:
 *
 *  - an id whose actor is gone is dropped (the GM deleted it from the sidebar);
 *  - a Trader actor missing from the order is appended (the GM duplicated one there).
 *
 * That inversion is the whole design. A registry treated as the authority would need deletion
 * hooks, sidebar hooks and a migration for every way an actor can vanish, and would still
 * eventually disagree with reality. Healing on read cannot drift, because reality is what it
 * reads from.
 *
 * Everything here is GM-side: creating actors and folders and writing a world setting all
 * require it. A player's client reaches Traders only through `trade/context.mjs`.
 */

/** The name of the module-managed Actors folder. Localised, so it reads properly in the sidebar. */
function folderName() {
  return t("manager.folderName");
}

/* -------------------------------------------- */
/*  The folder                                  */
/* -------------------------------------------- */

/**
 * The folder Trader actors live in, created on first use.
 *
 * Traders are kept in their own folder for one reason: they are Actors, so they appear in the
 * sidebar whether we like it or not, and a GM with fifteen shops should be able to collapse
 * them out of the way in one click rather than have them interleaved with the campaign's NPCs.
 *
 * The stored id is verified rather than trusted — a GM who deletes the folder gets a new one
 * rather than an error, and a Trader created into a deleted folder would otherwise fail.
 * @returns {Promise<object|null>}  The Folder, or null if one could not be made.
 */
export async function traderFolder() {
  const stored = setting(SETTINGS.traderFolder);
  const existing = stored ? game.folders.get(stored) : null;
  if ( existing && existing.type === "Actor" ) return existing;

  // A folder with the right name may already be there from a previous install whose setting was
  // lost; adopting it beats creating a second one beside it.
  const adopted = game.folders.find(f => f.type === "Actor" && f.name === folderName());
  const folder = adopted ?? await Folder.create({ name: folderName(), type: "Actor", sorting: "a" });
  if ( folder ) await game.settings.set(MODULE_ID, SETTINGS.traderFolder, folder.id);
  return folder ?? null;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/** Every Trader actor in the world, unordered. The authority on what exists. */
function allTraderActors() {
  return game.actors.filter(actor => isTrader(actor));
}

/**
 * Every Trader, in the GM's display order, with the registry healed as a side effect of reading.
 *
 * The heal is *not* written back here — a read must not write, or opening the manager would dirty
 * a world that nobody edited, and two clients reading at once would race. {@link pruneRegistry}
 * does the write, and the manager calls it when it saves.
 * @returns {object[]}  Trader actors.
 */
export function listTraders() {
  const order = orderedIds();
  const actors = allTraderActors();
  const byId = new Map(actors.map(a => [a.id, a]));

  // Registry order first, skipping anything that no longer resolves.
  const out = [];
  for ( const id of order ) {
    const actor = byId.get(id);
    if ( actor ) {
      out.push(actor);
      byId.delete(id);
    }
  }
  // Then anything the registry has not seen yet, newest last, so a duplicate appears beside
  // its original rather than vanishing until someone reorders.
  out.push(...[...byId.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)));
  return out;
}

/** The stored display order, guarded against a hand-edited setting. */
function orderedIds() {
  const raw = setting(SETTINGS.traders) ?? DEFAULTS.traders;
  const order = Array.isArray(raw?.order) ? raw.order : [];
  return order.filter(id => typeof id === "string");
}

/**
 * A Trader by id or uuid, or null.
 *
 * Accepts both because the chat card carries an id (short, and survives a world export) while
 * the API is documented in uuids (what every other Foundry API takes).
 * @param {string} idOrUuid
 * @returns {object|null}
 */
export function getTrader(idOrUuid) {
  if ( !idOrUuid ) return null;
  const direct = game.actors.get(idOrUuid);
  if ( direct ) return isTrader(direct) ? direct : null;
  const resolved = fromUuidSync(idOrUuid);
  return resolved && isTrader(resolved) ? resolved : null;
}

/* -------------------------------------------- */
/*  Writing                                     */
/* -------------------------------------------- */

/**
 * Write the healed order back to the setting, dropping dead ids and appending new Traders.
 * Called on save rather than on read, so reading the registry never dirties the world.
 * @returns {Promise<void>}
 */
export async function pruneRegistry() {
  const healed = listTraders().map(a => a.id);
  const current = orderedIds();
  if ( healed.length === current.length && healed.every((id, i) => id === current[i]) ) return;
  await game.settings.set(MODULE_ID, SETTINGS.traders, { order: healed });
}

/** Store an explicit display order, for drag-reordering the rail. */
export async function setOrder(ids) {
  const known = new Set(allTraderActors().map(a => a.id));
  const order = (Array.isArray(ids) ? ids : []).filter(id => known.has(id));
  // Anything the caller omitted keeps its place at the end rather than being forgotten.
  for ( const id of known ) if ( !order.includes(id) ) order.push(id);
  await game.settings.set(MODULE_ID, SETTINGS.traders, { order });
}

/**
 * Create a Trader and register it.
 * @param {object} [data]  Passed to {@link newTraderData}.
 * @returns {Promise<object|null>}  The new actor.
 */
export async function createTrader(data = {}) {
  const folder = await traderFolder();
  const actor = await Actor.create(newTraderData({ ...data, folder: folder?.id ?? null }));
  if ( !actor ) return null;
  await appendToOrder(actor.id);
  fireHook(HOOKS.traderCreated, { trader: actor });
  return actor;
}

/**
 * Copy a Trader, stock and all, without its opinions of anybody.
 *
 * "The same shop in the next town" is the usual reason to duplicate one, and that shop has
 * never met the party — see {@link clearHistory}.
 * @param {string} idOrUuid
 * @returns {Promise<object|null>}
 */
export async function duplicateTrader(idOrUuid) {
  const source = getTrader(idOrUuid);
  if ( !source ) return null;
  const folder = await traderFolder();
  const data = clearHistory(source.toObject());
  delete data._id;
  data.name = t("manager.copyName", { name: source.name });
  data.folder = folder?.id ?? null;
  const actor = await Actor.create(data, { keepId: false });
  if ( !actor ) return null;
  await appendToOrder(actor.id);
  fireHook(HOOKS.traderCreated, { trader: actor });
  return actor;
}

/**
 * Create a Trader from an export file.
 *
 * The file is guarded by `data/portable.mjs#parseTraderExport` before anything is created, and a
 * file it refuses creates nothing. The new Trader goes through the same creation data as one made
 * with the New button, so an imported Trader is indistinguishable from a native one — with a clean
 * history, since an export never carries one.
 * @param {string|object} raw  The file's text, or the parsed object.
 * @returns {Promise<{actor: object|null, error: string|null, items: number}>}
 *   `error` is a key suffix under `error.import.`, for the caller to localise.
 */
export async function importTrader(raw) {
  const parsed = parseTraderExport(raw);
  if ( !parsed.ok ) return { actor: null, error: parsed.error, items: 0 };

  const { trader, items } = parsed;
  const folder = await traderFolder();
  const data = newTraderData({
    name: trader.name,
    img: trader.img,
    greeting: trader.greeting,
    // Null means the file's Trader followed its world's default; follow this world's instead.
    startingAttitude: trader.startingAttitude ?? undefined,
    folder: folder?.id ?? null
  });
  Object.assign(data.flags[MODULE_ID], {
    buyFilter: trader.buyFilter,
    restock: { ...trader.restock, lastAt: 0 },
    attitudeGain: trader.attitudeGain
  });
  data.system = { currency: trader.currency };
  data.items = items;

  const actor = await Actor.create(data);
  if ( !actor ) return { actor: null, error: "failed", items: 0 };
  await appendToOrder(actor.id);
  log(`imported "${actor.name}" with ${actor.items.size} stock lines`);
  fireHook(HOOKS.traderCreated, { trader: actor });
  return { actor, error: null, items: actor.items.size };
}

/**
 * Delete a Trader.
 *
 * The hook fires *before* the document goes, so a listener can still read the Trader it is
 * being told about. Ordering it the other way round would hand listeners an id and nothing else.
 * @param {string} idOrUuid
 * @returns {Promise<boolean>}
 */
export async function deleteTrader(idOrUuid) {
  const actor = getTrader(idOrUuid);
  if ( !actor ) return false;
  fireHook(HOOKS.traderDeleted, { trader: actor });
  await actor.delete();
  await pruneRegistry();
  return true;
}

/** Put a new Trader at the end of the display order. */
async function appendToOrder(id) {
  const order = orderedIds();
  if ( !order.includes(id) ) order.push(id);
  await game.settings.set(MODULE_ID, SETTINGS.traders, { order });
}
