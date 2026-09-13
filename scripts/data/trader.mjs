import {
  HOOKS, MAX_STOCK_LINES, MODULE_ID, PHYSICAL_TYPES, SETTINGS, fireCancellableHook, fireHook, log, setting
} from "../config.mjs";
import { clampAttitude, emptySpend, recordSpend, sanitizeSpend, adjustAttitude } from "./attitude.mjs";
import { lockHaggle, sanitizeHaggleRecord } from "./haggle.mjs";
import { defaultRestock, dueForRestock, restockPlan, sanitizeRestock } from "./restock.mjs";
import {
  defaultBuyFilter, defaultLine, sanitizeBuyFilter, sanitizeLine, stockRoom, transferData
} from "./stock.mjs";
import {
  expandPool, isHollowTemplate, madeIdentity, makeRandomEnchantedData, makeScrollData, materialise
} from "./enchant.mjs";
import { serialised } from "./serial.mjs";
import { appendEntry, sanitizeLedger } from "./ledger.mjs";
import { archetypeUpdate, sanitizeRecipe } from "./archetypes.mjs";
import { budgetTotal, filterPool, pickByBudget } from "./generate.mjs";
import { itemPool } from "./item-index.mjs";

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
    haggle: raw.haggle && typeof raw.haggle === "object" ? raw.haggle : {},
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
 * Which haggling approaches a character has failed with this Trader, and on which in-game day.
 * @param {object} actor
 * @param {object|string} character
 * @returns {Record<string, number>}
 */
export function haggleRecordFor(actor, character) {
  return sanitizeHaggleRecord(traderData(actor).haggle[characterId(character)]);
}

/**
 * Lock one haggling skill for a character until the next in-game day.
 * @param {object} actor
 * @param {object|string} character
 * @param {string} skill
 * @returns {Promise<void>}
 */
export async function recordHaggleFailure(actor, character, skill) {
  const id = characterId(character);
  const next = lockHaggle(haggleRecordFor(actor, character), skill, game.time.worldTime);
  // Written whole rather than merged, so yesterday's locks are dropped rather than accumulating.
  await actor.update({ [`flags.${MODULE_ID}.haggle.-=${id}`]: null });
  await actor.setFlag(MODULE_ID, `haggle.${id}`, next);
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
 *
 * Only physical goods count. dnd5e adds a hidden, cached copy of a spell to any actor holding a
 * scroll of it (flagged `dnd5e.cachedFor`) so the scroll can be cast; that copy is the system's
 * bookkeeping, not something on the shelf.
 * @param {object} actor
 * @returns {{id: string, item: object, line: object}[]}
 */
export function stockEntries(actor) {
  const items = (actor?.items?.contents ?? []).filter(isStockItem);
  return items
    .map(item => ({ id: item.id, item, line: stockLine(item) }))
    .sort((a, b) => a.item.name.localeCompare(b.item.name, game.i18n.lang));
}

/**
 * Whether an embedded item is a stock line: physical gear, and not a spell dnd5e cached for a scroll.
 * @param {object} item
 * @returns {boolean}
 */
export function isStockItem(item) {
  return PHYSICAL_TYPES.includes(item?.type) && !item?.flags?.dnd5e?.cachedFor;
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
 * @param {boolean} [options.synthesize]  Make DMG templates into real items and spells into scrolls,
 *                                  at random. The manager passes false once the GM has chosen.
 * @param {() => number} [options.rng]
 * @returns {Promise<{created: object[], raised: object[], failed: string[], rejected: object[]}>}
 */
export async function addStockItems(actor, uuids, { qty = 1, line = {}, synthesize = true, rng = Math.random } = {}) {
  const sources = [];
  const failed = [];
  const rejected = [];

  for ( const uuid of uuids ?? [] ) {
    const item = await fromUuid(uuid).catch(() => null);
    if ( !item ) {
      failed.push(uuid);
      continue;
    }

    // A spell on a shop's shelf is a scroll of it — which is what a treasure table that rolls spells
    // means, and what dnd5e itself does when a spell is dropped into an inventory.
    if ( synthesize && item.type === "spell" ) {
      const data = await makeScrollData(item);
      if ( data ) sources.push({ data });
      else rejected.push({ uuid, name: item.name, type: item.type });
      continue;
    }

    // Reported rather than silently dropped: a GM who draws ten things from a table and gets
    // seven should be told which three a shop cannot sell, and why.
    if ( !PHYSICAL_TYPES.includes(item.type) ) {
      rejected.push({ uuid, name: item.name, type: item.type });
      continue;
    }

    // A DMG template ("Weapon, +1, +2, or +3") is made into a real item at random when nobody is
    // there to choose. The manager asks the GM instead, through `addMadeStock`. A template with no
    // base the system can put it on is stocked as it is, which is no worse than before.
    if ( synthesize && isHollowTemplate(item) ) {
      const data = await makeRandomEnchantedData(item, { rng });
      if ( data ) {
        sources.push({ data });
        continue;
      }
    }

    sources.push({ item, uuid });
  }

  const result = await addStockData(actor, sources, { qty, line });
  return { ...result, failed: [...failed, ...result.failed], rejected };
}

/**
 * Add finished item data to a Trader's stock — an enchanted item or a scroll the GM chose, or what
 * the generator made.
 * @param {object} actor
 * @param {object[]} data       Creation data, as `data/enchant.mjs` builds it.
 * @param {object} [options]    As {@link addStockItems}.
 * @returns {Promise<{created: object[], raised: object[], failed: string[]}>}
 */
export function addMadeStock(actor, data, options = {}) {
  return addStockData(actor, (data ?? []).filter(Boolean).map(d => ({ data: d })), options);
}

/**
 * The shared end of every route into stock: merge what is already on the shelf, create the rest.
 *
 * Takes either a resolved item and its uuid, or ready-made creation data. Made items are recognised
 * by what they were made from (`data/enchant.mjs#madeIdentity`) rather than by name — a Longsword +1
 * and a Flame Tongue Longsword share a base item and would otherwise merge.
 * @param {object} actor
 * @param {({item: object, uuid: string}|{data: object})[]} sources
 * @param {object} [options]
 * @param {number} [options.qty]
 * @param {object} [options.line]
 * Stops at {@link MAX_STOCK_LINES}. What is already stocked is still raised when the shelf is full —
 * that takes no room — and what would need a new line is reported in `full` rather than created.
 * @returns {Promise<{created: object[], raised: object[], failed: string[], full: string[]}>}
 */
async function addStockData(actor, sources, { qty = 1, line = {} } = {}) {
  const created = [];
  const raised = [];
  const full = [];
  let room = stockRoom(stockEntries(actor).length);

  // Accumulated rather than appended, because one batch can name the same item more than once —
  // a generator drawing from overlapping packs, or a roll table with a repeated entry. Two
  // update entries for one `_id` is not a valid `updateEmbeddedDocuments` payload, and two
  // create entries would make two rows where the GM wanted one row of two.
  const raiseBy = new Map();      // existing item id -> how much to add
  const newRows = new Map();      // identity key -> the creation data being accumulated

  // Existing stock indexed three ways, because there are three ways to recognise "the same thing".
  //
  // What a made item was made from is exact. `compendiumSource` is the reliable one for everything
  // else: a GM dragging the same compendium item in again, or the generator picking it twice. But
  // an item that never came from a compendium — hand-made on the sheet, or copied off another
  // actor — has no source at all, and keying only on that made every such add a fresh row.
  //
  // So name-and-type is the fallback. It is deliberately *only* a fallback: two genuinely
  // different items can share a name, and for compendium items the uuid settles it properly.
  const byMade = new Map();
  const bySource = new Map();
  const byIdentity = new Map();
  for ( const item of actor.items ) {
    const made = madeIdentity(item.flags?.[MODULE_ID]?.madeFrom);
    if ( made ) {
      byMade.set(made, item);
      continue;
    }
    const source = item._stats?.compendiumSource;
    if ( source ) bySource.set(source, item);
    byIdentity.set(`${item.type}:${item.name}`, item);
  }

  for ( const entry of sources ) {
    const made = entry.data ? madeIdentity(entry.data.flags?.[MODULE_ID]?.madeFrom) : "";
    // Ready-made data that was not made from anything (an API caller's own item data) is matched the
    // way a hand-made item is: by its compendium source if it names one, else by type and name.
    const subject = entry.item ?? entry.data;
    const identity = made || `${subject.type}:${subject.name}`;
    const existing = made
      ? byMade.get(made)
      : (entry.uuid && bySource.get(entry.uuid))
        ?? bySource.get(subject._stats?.compendiumSource) ?? byIdentity.get(identity);

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

    if ( room <= 0 ) {
      full.push(entry.data?.name ?? entry.item?.name ?? "");
      continue;
    }
    room--;

    const source = entry.data ? structuredClone(entry.data) : entry.item.toObject();
    delete source._id;
    // Stock counts are the Trader's business, not the source item's: a compendium entry that
    // happens to say "quantity 20" must not silently stock twenty. And a Trader's copy is never
    // equipped or attuned, whatever the item it was copied from was.
    const clean = transferData(source, qty);
    const madeFrom = source.flags?.[MODULE_ID]?.madeFrom;
    clean.flags = {
      ...clean.flags,
      [MODULE_ID]: { ...sanitizeLine({ ...line, baseQty: qty }), ...(madeFrom ? { madeFrom } : {}) }
    };
    if ( entry.item ) {
      clean._stats = { ...clean._stats, compendiumSource: originUuid(entry.item, entry.uuid) };
    }
    newRows.set(identity, clean);
  }

  const toUpdate = [...raiseBy].map(([id, add]) => ({
    _id: id,
    "system.quantity": (Number(actor.items.get(id)?.system?.quantity) || 0) + add
  }));
  if ( toUpdate.length ) await actor.updateEmbeddedDocuments("Item", toUpdate);
  const failed = [];
  if ( newRows.size ) {
    const rows = [...newRows.values()];
    const made = await actor.createEmbeddedDocuments("Item", rows);
    created.push(...made);
    // A `preCreateItem` listener can quietly refuse a row; say so rather than report it stocked.
    if ( made.length < rows.length ) failed.push(...rows.slice(made.length).map(r => r.name));
  }

  logTrader(actor, `stock added: ${created.length} new, ${raised.length} raised, ${failed.length} refused, `
    + `${full.length} over the ${MAX_STOCK_LINES}-line limit`);
  return { created, raised, failed, full };
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
        haggle: {},
        attitudeGain: null,
        buyFilter: defaultBuyFilter(),
        restock: defaultRestock(),
        ledger: []
      }
    }
  };
}

/**
 * Strip a Trader's per-character history, for a duplicate.
 *
 * A copied Trader must not inherit the original's opinions: "the same shop in the next town"
 * is the common reason to duplicate one, and it has never met the party. Nor its ledger — the
 * copy has sold nothing to anybody.
 * @param {object} data  Actor data from `toObject()`.
 * @returns {object}
 */
export function clearHistory(data) {
  const flags = data.flags?.[MODULE_ID] ?? {};
  return {
    ...data,
    flags: { ...data.flags, [MODULE_ID]: { ...flags, attitude: {}, spend: {}, haggle: {}, ledger: [] } }
  };
}

/* -------------------------------------------- */
/*  The ledger                                  */
/* -------------------------------------------- */

/**
 * A Trader's ledger, guarded and newest first.
 *
 * Kept out of {@link traderData} on purpose. That is read on every price and every attitude
 * lookup, and sanitising a hundred ledger entries each time would be work nobody asked for.
 * @param {object} actor
 * @returns {import("./ledger.mjs").LedgerEntry[]}
 */
export function ledgerOf(actor) {
  return sanitizeLedger(actor?.flags?.[MODULE_ID]?.ledger);
}

/**
 * Add one settled trade to a Trader's ledger.
 *
 * Only ever called from inside the settlement queue, so two trades finishing together cannot
 * each read the old ledger and write back a copy missing the other's entry.
 * @param {object} actor
 * @param {import("./ledger.mjs").LedgerEntry} entry
 * @returns {Promise<void>}
 */
export async function recordTrade(actor, entry) {
  await actor.setFlag(MODULE_ID, "ledger", appendEntry(ledgerOf(actor), entry));
}

/**
 * Empty a Trader's ledger. Goes through the settlement queue, for the same reason as a restock:
 * a clear landing mid-settlement must not be overwritten by the ledger that settlement read.
 * @param {object} actor
 * @returns {Promise<void>}
 */
export function clearLedger(actor) {
  return serialised(async () => {
    await actor.setFlag(MODULE_ID, "ledger", []);
    logTrader(actor, "ledger cleared");
  });
}

/* -------------------------------------------- */
/*  Archetypes                                  */
/* -------------------------------------------- */

/**
 * Give a Trader an archetype's character: its buy filter, restock rule and starting attitude.
 *
 * Leaves the stock alone. Whether to fill the shelves too is a separate decision, made with
 * {@link stockFromRecipe} — a GM re-theming a shop they have already stocked by hand does not want
 * twenty more items dropped on top.
 * @param {object} actor
 * @param {import("./archetypes.mjs").Archetype} archetype
 * @returns {Promise<void>}
 */
export async function applyArchetype(actor, archetype) {
  const update = archetypeUpdate(archetype);
  if ( !Object.keys(update).length ) return;
  await actor.update(update);
  logTrader(actor, `archetype applied: ${archetype.id}`);
}

/**
 * Fill a Trader's shelves from a stock recipe.
 *
 * The one path generation goes through, whether the GM pressed Generate in the Stock tab, applied
 * an archetype with stock, or a macro called the API — so all three honour the same narrowing,
 * report the same shortfalls, and merge into existing lines the same way.
 * @param {object} actor
 * @param {import("./archetypes.mjs").Recipe} recipe
 * @param {object} [options]
 * @param {() => number} [options.rng]  Injected for a reproducible run.
 * @returns {Promise<{picked: number, shortfalls: Record<string, number>, created: object[],
 *   raised: object[], failed: string[], rejected: object[]}>}
 */
export async function stockFromRecipe(actor, recipe, { rng = Math.random } = {}) {
  const r = sanitizeRecipe(recipe);
  const empty = { picked: 0, shortfalls: {}, created: [], raised: [], failed: [], rejected: [], full: [] };
  if ( budgetTotal(r.budget) <= 0 ) return empty;

  const pool = filterPool(await stockPool(), {
    packs: r.packs, categories: r.categories, maxValueCp: r.maxValueCp
  });
  const { picked, shortfalls } = pickByBudget({ pool, budget: r.budget, rng });
  if ( !picked.length ) return { ...empty, shortfalls };

  // Templates and scrolls in the pick become finished items here, within the recipe's kinds and
  // ceiling; everything else is stocked from its compendium entry as before.
  const { uuids, data, failed: unmade } = await materialise(picked, {
    categories: r.categories, maxValueCp: r.maxValueCp, rng
  });
  const plain = await addStockItems(actor, uuids, { synthesize: false });
  const made = await addMadeStock(actor, data);
  return {
    picked: picked.length,
    shortfalls,
    created: [...plain.created, ...made.created],
    raised: [...plain.raised, ...made.raised],
    failed: [...plain.failed, ...made.failed, ...unmade],
    rejected: plain.rejected,
    full: [...plain.full, ...made.full]
  };
}

/**
 * The generator's pool: every stockable item the world can see, with DMG templates and blank
 * scrolls replaced by what can really be made from them. Built on the cached compendium pool.
 * @param {object} [options]
 * @param {boolean} [options.refresh]
 * @returns {Promise<object[]>}
 */
export async function stockPool({ refresh = false } = {}) {
  return expandPool(await itemPool({ refresh }));
}

/* -------------------------------------------- */

/** Log helper so the manager's writes are traceable with debug logging on. */
export function logTrader(actor, ...args) {
  log(`trader "${actor?.name ?? "?"}" (${actor?.id ?? "?"})`, ...args);
}
