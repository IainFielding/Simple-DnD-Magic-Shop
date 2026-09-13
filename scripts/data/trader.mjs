import {
  HOOKS, MODULE_ID, PHYSICAL_TYPES, SETTINGS, fireCancellableHook, fireHook, log, setting
} from "../config.mjs";
import { clampAttitude, emptySpend, recordSpend, sanitizeSpend, adjustAttitude } from "./attitude.mjs";
import { defaultRestock, dueForRestock, restockPlan, sanitizeRestock } from "./restock.mjs";
import { defaultBuyFilter, defaultLine, sanitizeBuyFilter, sanitizeLine } from "./stock.mjs";
import { serialised } from "./serial.mjs";

/**
 * Reading and writing a Trader.
 *
 * A Trader is an ordinary dnd5e `npc` Actor that the module created and owns, with its shop
 * configuration in a flag. Its **stock is the actor's embedded Items** — real documents, so
 * price, rarity, attunement, weight and tooltips all come for free, and `system.quantity` *is*
 * the count. Its purse is `system.currency`, same as any other actor's.
 *
 * Per-line shop settings live in a flag on **each embedded item** rather than in a map on the
 * actor. That is deliberate: a map keyed by embedded-item id orphans the moment an item is
 * deleted or duplicated, and nothing ever cleans it up. On the item, the settings travel with
 * the thing they describe.
 *
 * ## Where the boundary is
 *
 * This module is the only place that knows the flag layout, and every *write* here is GM-side.
 * A player's client never reaches these functions — it receives a context payload built by
 * `trade/context.mjs` and sends back intent. See docs/PLAN.md §6.
 *
 * The arithmetic all lives in the pure modules (`pricing`, `attitude`, `stock`, `restock`);
 * this file is the persistence layer and nothing more, so a rule change happens in one place
 * and is unit-testable without a world.
 */

/* -------------------------------------------- */
/*  Identity                                    */
/* -------------------------------------------- */

/** Whether an actor is one of this module's Traders. */
export function isTrader(actor) {
  return actor?.getFlag?.(MODULE_ID, "isTrader") === true;
}

/**
 * Read the whole shop configuration off a Trader, guarded field by field.
 *
 * Never returns a partial object: a Trader whose flag is missing, half-written by an older
 * version, or hand-edited comes back with defaults for whatever is absent. Every caller can
 * therefore treat the result as complete, which is what keeps `?.` out of the pricing path.
 * @param {object} actor
 * @returns {object}
 */
export function traderData(actor) {
  // Read the flag object directly rather than through `getFlag`. `getFlag(scope, key)` forwards
  // `key` to `getProperty`, so calling it with no key returns **undefined** rather than the
  // whole scope — which silently made every Trader look freshly created: no greeting, no
  // stored attitudes, the world's default starting attitude. The e2e harness caught it; no
  // unit test could, because the shims have no real documents.
  const raw = actor?.flags?.[MODULE_ID] ?? {};
  return {
    isTrader: raw.isTrader === true,
    greeting: typeof raw.greeting === "string" ? raw.greeting : "",
    startingAttitude: Number.isFinite(Number(raw.startingAttitude))
      ? clampAttitude(raw.startingAttitude)
      : clampAttitude(setting(SETTINGS.startingAttitude)),
    attitude: raw.attitude && typeof raw.attitude === "object" ? raw.attitude : {},
    spend: raw.spend && typeof raw.spend === "object" ? raw.spend : {},
    attitudeGain: sanitizeGain(raw.attitudeGain),
    buyFilter: sanitizeBuyFilter(raw.buyFilter),
    restock: sanitizeRestock(raw.restock)
  };
}

/**
 * Guard a per-Trader attitude-gain override. `null` means "use the world's settings", which is
 * the default and must stay distinguishable from "0 copper per point" (drift switched off).
 * @param {*} raw
 * @returns {{cpPerPoint: number, capPerVisit: number}|null}
 */
function sanitizeGain(raw) {
  if ( !raw || typeof raw !== "object" ) return null;
  const per = Number(raw.cpPerPoint);
  const cap = Number(raw.capPerVisit);
  if ( !Number.isFinite(per) || !Number.isFinite(cap) ) return null;
  return { cpPerPoint: Math.max(0, Math.round(per)), capPerVisit: Math.max(0, Math.round(cap)) };
}

/**
 * The goodwill-drift settings in force for a Trader: its own override, else the world's.
 * @param {object} actor
 * @returns {{cpPerPoint: number, capPerVisit: number}}
 */
export function gainSettings(actor) {
  const own = traderData(actor).attitudeGain;
  if ( own ) return own;
  return {
    cpPerPoint: Math.max(0, Math.round(Number(setting(SETTINGS.attitudeGainPerPoint)) || 0)),
    capPerVisit: Math.max(0, Math.round(Number(setting(SETTINGS.attitudeGainCap)) || 0))
  };
}

/** The Trader's purse, in the shape dnd5e stores it. */
export function purse(actor) {
  return actor?.system?.currency ?? {};
}

/* -------------------------------------------- */
/*  Attitude                                    */
/* -------------------------------------------- */

/**
 * A Trader's opinion of one character.
 *
 * A character the Trader has never met gets the Trader's own starting preset — that is what
 * makes "a gouging merchant starts everyone at 20" a one-field decision rather than a table
 * the GM has to fill in per player.
 * @param {object} actor       The Trader.
 * @param {object|string} character  A character actor or its id.
 * @returns {number}  0-100.
 */
export function getAttitude(actor, character) {
  const id = characterId(character);
  const data = traderData(actor);
  const stored = data.attitude[id];
  if ( stored === undefined || stored === null ) return data.startingAttitude;
  return clampAttitude(stored);
}

/**
 * Write a Trader's opinion of one character, firing the cancellable hook.
 *
 * Returns the outcome rather than the new value so a caller can tell "held at 100" from
 * "vetoed" from "moved" — a no-op must not write a document, and an adored party would
 * otherwise generate a write and a hook on every purchase forever.
 * @param {object} actor
 * @param {object|string} character
 * @param {number} value
 * @param {object} [options]
 * @param {string} [options.reason]  For the hook payload: "gm", "spend", an API caller's own.
 * @returns {Promise<{from: number, to: number, changed: boolean, vetoed: boolean}>}
 */
export async function setAttitude(actor, character, value, { reason = "gm" } = {}) {
  const id = characterId(character);
  const from = getAttitude(actor, character);
  const to = clampAttitude(value);
  if ( to === from ) return { from, to, changed: false, vetoed: false };

  const payload = { trader: actor, actor: character, from, to, reason };
  if ( !fireCancellableHook(HOOKS.preAttitudeChange, payload) ) {
    return { from, to: from, changed: false, vetoed: true };
  }

  await actor.setFlag(MODULE_ID, `attitude.${id}`, to);
  fireHook(HOOKS.attitudeChanged, { ...payload, to });
  return { from, to, changed: true, vetoed: false };
}

/**
 * Nudge a Trader's opinion by a delta, clamped into range.
 * @param {object} actor
 * @param {object|string} character
 * @param {number} delta
 * @param {object} [options]
 * @returns {Promise<{from: number, to: number, changed: boolean, vetoed: boolean}>}
 */
export async function nudgeAttitude(actor, character, delta, options = {}) {
  const { to } = adjustAttitude(getAttitude(actor, character), delta);
  return setAttitude(actor, character, to, options);
}

/**
 * Book a purchase against a character's spend record and apply whatever goodwill it earns.
 *
 * Called from the authoritative trade path only, after the coin has moved. The spend record is
 * written whether or not any attitude was earned, because the visit total is what makes small
 * purchases add up and what makes the per-visit cap unbeatable by splitting a basket.
 * @param {object} actor
 * @param {object|string} character
 * @param {number} spentCp
 * @returns {Promise<{points: number, from: number, to: number}>}
 */
export async function bookSpend(actor, character, spentCp) {
  const id = characterId(character);
  const { cpPerPoint, capPerVisit } = gainSettings(actor);
  const { spend, points } = recordSpend({
    spend: traderData(actor).spend[id],
    spentCp,
    worldTime: game.time.worldTime,
    cpPerPoint,
    cap: capPerVisit
  });

  await actor.setFlag(MODULE_ID, `spend.${id}`, spend);
  if ( points <= 0 ) {
    const held = getAttitude(actor, character);
    return { points: 0, from: held, to: held };
  }
  const result = await nudgeAttitude(actor, character, points, { reason: "spend" });
  return { points, from: result.from, to: result.to };
}

/** A character's spend record at this Trader, guarded. */
export function spendFor(actor, character) {
  const raw = traderData(actor).spend[characterId(character)];
  return raw ? sanitizeSpend(raw) : emptySpend();
}

/**
 * Accept either an actor or a bare id everywhere a character is named.
 *
 * The authoritative path has the document; the manager's attitude table often has only the id;
 * and the API must accept both, because a macro author will pass whichever they have.
 * @param {object|string} character
 * @returns {string}
 */
export function characterId(character) {
  return typeof character === "string" ? character : character?.id ?? "";
}

/* -------------------------------------------- */
/*  Stock                                       */
/* -------------------------------------------- */

/**
 * The shop settings on one embedded stock item.
 *
 * Reads the flag object directly, for the reason given in {@link traderData}: `getFlag` with no
 * key returns undefined, not the scope.
 */
export function stockLine(item) {
  return sanitizeLine(item?.flags?.[MODULE_ID]);
}

/**
 * Every stock line on a Trader, paired with its item.
 *
 * Sorted by name in the player's locale, because the panels render in this order and an
 * unsorted shelf reads as random. Items the module has no line for still appear — an item
 * dropped straight onto the actor sheet is stock too, just stock with default settings.
 * @param {object} actor
 * @returns {{id: string, item: object, line: object}[]}
 */
export function stockEntries(actor) {
  const items = actor?.items?.contents ?? [];
  return items
    .map(item => ({ id: item.id, item, line: stockLine(item) }))
    .sort((a, b) => a.item.name.localeCompare(b.item.name, game.i18n.lang));
}

/**
 * Patch one stock line's settings.
 *
 * Written as a flag update on the embedded item rather than through `setFlag`, so several
 * lines can be changed in one `updateEmbeddedDocuments` call — the stock table saves a whole
 * table at once, and one document write per row would be both slow and a flicker.
 * @param {string} itemId
 * @param {Partial<import("./stock.mjs").StockLine>} patch
 * @returns {object}  An entry for `updateEmbeddedDocuments("Item", …)`.
 */
export function stockLineUpdate(itemId, patch) {
  return { _id: itemId, [`flags.${MODULE_ID}`]: { ...defaultLine(), ...patch } };
}

/**
 * Add items to a Trader's stock from their uuids.
 *
 * The one path every source of stock goes through — a drag-and-drop, the compendium picker, the
 * rarity generator, a roll-table draw, and the API's `addStock` — so a line created one way is
 * indistinguishable from one created another.
 *
 * Two decisions worth knowing:
 *
 *  - **Quantity is reset to the line's own, not the source item's.** A compendium entry that
 *    happens to say "quantity 20" must not silently stock twenty; the Trader's shelf count is
 *    the Trader's business.
 *  - **Duplicates raise the existing line instead of adding a second row.** Dropping the same
 *    potion twice means "I want more of these", not "give me two identical rows to edit
 *    separately". Matching is on the item's compendium source rather than its name, so two
 *    different swords that happen to share a name stay separate.
 *
 * @param {object} actor            The Trader.
 * @param {string[]} uuids          Item uuids to add.
 * A Trader can only stock **physical gear**, and that is enforced here rather than at each call
 * site. The picker locks the browser to physical types and the generator's pool is filtered to
 * them, but a *roll table* hands back whatever it contains — a treasure table that also rolls
 * spells would otherwise put a spell on a shop's shelves, where it has no price, cannot be
 * bought, and cannot be removed except through the actor sheet. The API can be handed anything
 * at all. One guard on the shared path covers every route in.
 *
 * @param {object} [options]
 * @param {number} [options.qty]    Stock count for each new line.
 * @param {object} [options.line]   Line settings for each new line.
 * @returns {Promise<{created: object[], raised: object[], failed: string[], rejected: object[]}>}
 */
export async function addStockItems(actor, uuids, { qty = 1, line = {} } = {}) {
  const created = [];
  const raised = [];
  const failed = [];
  const rejected = [];

  // Accumulated rather than appended, because one batch can name the same item more than once —
  // a generator drawing from overlapping packs, or a roll table with a repeated entry. Two
  // update entries for one `_id` is not a valid `updateEmbeddedDocuments` payload, and two
  // create entries would make two rows where the GM wanted one row of two.
  const raiseBy = new Map();      // existing item id -> how much to add
  const newRows = new Map();      // identity key -> the creation data being accumulated

  // Existing stock indexed twice, because there are two ways to recognise "the same thing".
  //
  // `compendiumSource` is the reliable one and covers the common path: a GM dragging the same
  // compendium item in again, or the generator picking it twice. But an item that never came
  // from a compendium — hand-made on the sheet, or copied off another actor — has no source at
  // all, and keying only on that made every such add a fresh row.
  //
  // So name-and-type is the fallback. It is deliberately *only* a fallback: two genuinely
  // different items can share a name, and for compendium items the uuid settles it properly.
  const bySource = new Map();
  const byIdentity = new Map();
  for ( const item of actor.items ) {
    const source = item._stats?.compendiumSource;
    if ( source ) bySource.set(source, item);
    byIdentity.set(`${item.type}:${item.name}`, item);
  }

  for ( const uuid of uuids ?? [] ) {
    const item = await fromUuid(uuid).catch(() => null);
    if ( !item ) {
      failed.push(uuid);
      continue;
    }

    // Reported rather than silently dropped: a GM who draws ten things from a table and gets
    // seven should be told which three a shop cannot sell, and why.
    if ( !PHYSICAL_TYPES.includes(item.type) ) {
      rejected.push({ uuid, name: item.name, type: item.type });
      continue;
    }

    const identity = `${item.type}:${item.name}`;
    const existing = bySource.get(uuid)
      ?? bySource.get(item._stats?.compendiumSource)
      ?? byIdentity.get(identity);

    if ( existing ) {
      // An unlimited line cannot be "raised" — there is nothing to add to — but it still counts
      // as found, so the caller reports "already stocked" rather than "nothing happened".
      if ( !stockLine(existing).unlimited ) {
        raiseBy.set(existing.id, (raiseBy.get(existing.id) ?? 0) + qty);
      }
      raised.push(existing);
      continue;
    }

    // A second mention of something new in the same batch raises the row being built.
    const pending = newRows.get(identity);
    if ( pending ) {
      pending.system.quantity += qty;
      pending.flags[MODULE_ID].baseQty += qty;
      continue;
    }

    const source = item.toObject();
    delete source._id;
    // Stock counts are the Trader's business, not the source item's: a compendium entry that
    // happens to say "quantity 20" must not silently stock twenty.
    source.system = { ...source.system, quantity: qty };
    source.flags = { ...source.flags, [MODULE_ID]: sanitizeLine({ ...line, baseQty: qty }) };
    source._stats = { ...source._stats, compendiumSource: originUuid(item, uuid) };
    newRows.set(identity, source);
  }

  const toUpdate = [...raiseBy].map(([id, add]) => ({
    _id: id,
    "system.quantity": (Number(actor.items.get(id)?.system?.quantity) || 0) + add
  }));
  if ( toUpdate.length ) await actor.updateEmbeddedDocuments("Item", toUpdate);
  if ( newRows.size ) {
    created.push(...await actor.createEmbeddedDocuments("Item", [...newRows.values()]));
  }

  logTrader(actor, `stock added: ${created.length} new, ${raised.length} raised, `
    + `${rejected.length} not stockable, ${failed.length} unresolved`);
  return { created, raised, failed, rejected };
}

/**
 * Where a stocked item came from, for `_stats.compendiumSource`.
 *
 * Foundry does **not** stamp this when you create an embedded document from raw data, and a
 * compendium item's *own* `compendiumSource` is empty — it records where a document was copied
 * *from*, and an original was not copied from anywhere. So adding stock left every line with no
 * origin at all.
 *
 * That was not merely untidy. A receipt links the item's compendium entry rather than the copy
 * that was traded, precisely because the traded copy may not survive the trade — buying the last
 * of a line deletes it. With no origin recorded there was nothing durable left to link, and the
 * receipt for the most interesting purchase in the world silently rendered as plain text.
 *
 * It is also what makes the duplicate check in {@link addStockItems} reliable rather than
 * falling back to matching on name.
 * @param {object} item   The resolved source item.
 * @param {string} uuid   The uuid it was resolved from.
 * @returns {string|null}
 */
function originUuid(item, uuid) {
  if ( typeof uuid === "string" && uuid.startsWith("Compendium.") ) return uuid;
  // Dragged from the sidebar or copied off another actor: keep whatever origin it already had,
  // which may still be a compendium entry further back.
  return item?._stats?.compendiumSource ?? null;
}

/* -------------------------------------------- */
/*  Restocking                                  */
/* -------------------------------------------- */

/**
 * Refill a Trader's shelves to their configured baselines.
 *
 * Unconditional: it does not consult the Trader's restock *mode*, because both callers have
 * already decided. The GM's Restock button means "now, regardless", and the world-time sweep
 * ({@link sweepRestocks}) has already asked {@link dueForRestock}. Folding the mode check in
 * here would make the button a no-op on a `none`-mode Trader, which is not what a button that
 * says "Restock" should do.
 *
 * The timestamp is written even when nothing changed, so a shop that was already full does not
 * come up due again on the next tick.
 * @param {object} actor
 * @returns {Promise<{added: object[], skipped: boolean}>}
 */
export function restockTrader(actor) {
  // Through the settlement queue: a refill computed from a quantity a purchase is about to change
  // would write the stale number back over the sale.
  return serialised(() => restockNow(actor));
}

async function restockNow(actor) {
  if ( !fireCancellableHook(HOOKS.preRestock, { trader: actor }) ) {
    logTrader(actor, "restock vetoed by a listener");
    return { added: [], skipped: true };
  }

  const plan = restockPlan(stockEntries(actor), game.time.worldTime);
  if ( plan.updates.length ) await actor.updateEmbeddedDocuments("Item", plan.updates);
  await actor.setFlag(MODULE_ID, "restock.lastAt", plan.lastAt);

  if ( plan.added.length ) fireHook(HOOKS.restocked, { trader: actor, added: plan.added });
  logTrader(actor, `restocked ${plan.added.length} line(s)`);
  return { added: plan.added, skipped: false };
}

/**
 * Restock every Trader whose interval has elapsed.
 *
 * Hooked to world time on the GM's client only — see `main.mjs`. Two GMs would otherwise both
 * sweep on the same tick and each fire the `restocked` hook, and while the writes themselves
 * are idempotent the duplicate announcement is not.
 * @param {number} worldTime
 * @returns {Promise<number>}  How many Traders were refilled.
 */
export async function sweepRestocks(worldTime) {
  let count = 0;
  for ( const actor of game.actors ) {
    if ( !isTrader(actor) ) continue;
    if ( !dueForRestock(traderData(actor).restock, worldTime) ) continue;
    const result = await restockTrader(actor);
    if ( !result.skipped ) count++;
  }
  if ( count ) log(`world time advanced: restocked ${count} trader(s)`);
  return count;
}

/* -------------------------------------------- */
/*  Creation data                               */
/* -------------------------------------------- */

/** The portrait a Trader gets when the GM does not pick one. */
export const DEFAULT_TRADER_IMG = "icons/environment/settlement/market-stall.webp";

/**
 * The actor data for a new Trader.
 *
 * Kept here rather than in the manager so the API's `createTrader` and the manager's New button
 * cannot drift into producing differently-shaped Traders.
 * @param {object} [options]
 * @returns {object}  Data for `Actor.create`.
 */
export function newTraderData({ name, img, greeting = "", startingAttitude, folder } = {}) {
  return {
    name: name || game.i18n.localize(`${MODULE_ID}.manager.defaultName`),
    type: "npc",
    img: img || DEFAULT_TRADER_IMG,
    folder: folder ?? null,
    // A Trader is a shopkeeper, not a combatant, and a token on the board would be misleading.
    prototypeToken: { actorLink: true, disposition: CONST.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0 },
    flags: {
      [MODULE_ID]: {
        isTrader: true,
        greeting,
        startingAttitude: clampAttitude(
          startingAttitude ?? setting(SETTINGS.startingAttitude)
        ),
        attitude: {},
        spend: {},
        attitudeGain: null,
        buyFilter: defaultBuyFilter(),
        restock: defaultRestock()
      }
    }
  };
}

/**
 * Strip a Trader's per-character history, for a duplicate.
 *
 * A copied Trader must not inherit the original's opinions: "the same shop in the next town"
 * is the common reason to duplicate one, and it has never met the party.
 * @param {object} data  Actor data from `toObject()`.
 * @returns {object}
 */
export function clearHistory(data) {
  const flags = data.flags?.[MODULE_ID] ?? {};
  return {
    ...data,
    flags: { ...data.flags, [MODULE_ID]: { ...flags, attitude: {}, spend: {} } }
  };
}

/* -------------------------------------------- */

/** Log helper so the manager's writes are traceable with debug logging on. */
export function logTrader(actor, ...args) {
  log(`trader "${actor?.name ?? "?"}" (${actor?.id ?? "?"})`, ...args);
}
