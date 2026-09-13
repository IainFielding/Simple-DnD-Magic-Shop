import {
  HOOKS, MODULE_ID, PRICING_PRESETS, SETTINGS, log, pricingAnchors, t
} from "./config.mjs";
import { attitudeTier } from "./data/attitude.mjs";
import {
  favour, formatCp, priceMultipliers, pricesFor, toCopper, validateAnchors
} from "./data/pricing.mjs";
import {
  createTrader, deleteTrader, duplicateTrader, getTrader, importTrader, listTraders
} from "./data/registry.mjs";
import {
  addStockItems, applyArchetype, clearLedger, getAttitude, ledgerOf, nudgeAttitude, restockTrader,
  setAttitude, spendFor, stockEntries, stockFromRecipe, stockLine, traderData
} from "./data/trader.mjs";
import { sanitizeLine } from "./data/stock.mjs";
import {
  archetypeFromTrader, deleteArchetype, getArchetype, listArchetypes, saveArchetype
} from "./data/archetypes.mjs";
import { entriesFor } from "./data/ledger.mjs";
import { exportTrader } from "./data/portable.mjs";
import { buildShopContext, resolvePayer } from "./trade/context.mjs";
import { QUERIES, askGM, gmAvailable } from "./trade/queries.mjs";
import { ShopApp } from "./app/shop-app.mjs";
import { TraderManagerApp } from "./app/manager-app.mjs";
import { postTraderCard } from "./app/chat-card.mjs";

/**
 * The module's public API, installed on `game.modules.get(MODULE_ID).api`.
 *
 * ## Three tiers, because the permission model is real
 *
 * The API cannot pretend the GM/player boundary away, so it is honest about which side a call
 * belongs on:
 *
 *  - **Pure** — maths only. Safe anywhere, touches no document, needs no GM.
 *  - **Read** — resolves locally for a GM, and through a GM query for a player.
 *  - **Write** — GM-only, *except* the three trade calls, which deliberately route through the
 *    authoritative path so a macro gets exactly the same validation a player's shop does.
 *
 * A GM-only call from a player client rejects with a named error rather than failing quietly or
 * half-working. That is the whole point of {@link requireGM}: a macro author who gets it wrong
 * should be told, not left with a silently broken hotbar button.
 *
 * ## What is frozen and why
 *
 * The surface is frozen, and so is `HOOKS`. Hook names are a contract with every consumer, and
 * a module that could rewrite one at runtime could break another module's listeners in a way
 * nobody would ever trace.
 *
 * See docs/API.md for the payload of every hook and an example of each call.
 */

/**
 * Refuse a write from a client that has no business making it.
 * @param {string} call  The API method's name, for the message.
 * @throws {Error}
 */
function requireGM(call) {
  if ( !game.user.isGM ) throw new Error(t("error.gmOnly", { call }));
}

/**
 * Resolve a Trader for a *read*, from either side of the boundary.
 *
 * A GM gets the document. A player cannot be given one they may not use, so they get the id
 * back and the call routes through a query — see {@link api.getShopContext}.
 * @param {string} idOrUuid
 * @returns {object}
 */
function traderOrThrow(idOrUuid) {
  const trader = getTrader(idOrUuid);
  if ( !trader ) throw new Error(t("error.noTrader"));
  return trader;
}

/** A character from an id, a uuid, or a document. */
function characterOrThrow(actor) {
  if ( actor && typeof actor === "object" ) return actor;
  const resolved = typeof actor === "string"
    ? (game.actors.get(actor) ?? fromUuidSync(actor))
    : game.user.character;
  if ( !resolved ) throw new Error(t("error.noCharacter"));
  return resolved;
}

/* -------------------------------------------- */

/**
 * Build the API object.
 *
 * Assembled in one place rather than accreted across files, so `docs/API.md` has exactly one
 * thing to stay in step with and the harness has exactly one shape to assert against.
 * @returns {object}  The frozen API.
 */
export function buildApi() {
  const api = {

    /* ---------------------------------------- */
    /*  Identity                                */
    /* ---------------------------------------- */

    MODULE_ID,
    HOOKS,
    SETTINGS,
    PRICING_PRESETS,
    get version() {
      return game.modules.get(MODULE_ID)?.version ?? "";
    },

    /* ---------------------------------------- */
    /*  Pure — safe on any client               */
    /* ---------------------------------------- */

    /**
     * The Favour score for a Charisma modifier and an attitude, −1 … +1.
     * @param {{chaMod: number, attitude: number}} params
     * @returns {number}
     */
    favour(params) {
      return favour(params);
    },

    /**
     * The buy and sell multipliers for a Charisma modifier and an attitude.
     *
     * Uses the world's pricing preset unless `anchors` is given, so a caller previewing a
     * different curve can pass one without changing the world.
     * @param {{chaMod: number, attitude: number, anchors?: object}} params
     * @returns {{buy: number, sell: number, favour: number}}
     */
    priceMultipliers(params) {
      return priceMultipliers({ anchors: pricingAnchors(), ...params });
    },

    /**
     * Both prices for a list value, in copper and formatted.
     * @param {number} valueCp
     * @param {{chaMod: number, attitude: number}} params
     * @returns {{buyCp: number, sellCp: number, buy: string, sell: string}}
     */
    priceFor(valueCp, params) {
      const multipliers = api.priceMultipliers(params);
      const { buyCp, sellCp } = pricesFor(valueCp, multipliers);
      return { buyCp, sellCp, buy: formatCp(buyCp), sell: formatCp(sellCp) };
    },

    /**
     * The tier an attitude falls in, with its localised label.
     * @param {number} value
     * @returns {{key: string, label: string, value: number}}
     */
    attitudeTier(value) {
      return attitudeTier(value);
    },

    /**
     * Check an anchor set against the model's invariants — positive, monotonic, and
     * arbitrage-free. Useful to a module offering its own pricing presets.
     * @param {object} anchors
     * @returns {{ok: boolean, errors: string[]}}
     */
    validateAnchors(anchors) {
      return validateAnchors(anchors);
    },

    /** Convert an amount of a denomination to copper, which every `…Cp` argument expects. */
    toCopper(amount, denomination = "gp") {
      return toCopper(amount, denomination);
    },

    /** Format copper for display, gp/sp/cp. */
    formatCp(cp) {
      return formatCp(cp);
    },

    /* ---------------------------------------- */
    /*  Read                                    */
    /* ---------------------------------------- */

    /**
     * Every Trader in the world, in the GM's display order.
     *
     * Returns plain summaries rather than documents: a player can hold these safely, and a
     * caller wanting the document can ask the GM for it.
     * @returns {{id: string, uuid: string, name: string, img: string, stockCount: number}[]}
     */
    listTraders() {
      return listTraders().map(trader => ({
        id: trader.id,
        uuid: trader.uuid,
        name: trader.name,
        img: trader.img,
        stockCount: trader.items.size
      }));
    },

    /**
     * A Trader's document. GM-only, because a player has no rights on one and handing them a
     * document they cannot use would only invite confusion.
     * @param {string} idOrUuid
     * @returns {object}
     */
    getTrader(idOrUuid) {
      requireGM("getTrader");
      return traderOrThrow(idOrUuid);
    },

    /** A Trader's configuration — greeting, buy filter, restock, starting attitude. GM-only. */
    getTraderData(idOrUuid) {
      requireGM("getTraderData");
      return traderData(traderOrThrow(idOrUuid));
    },

    /**
     * A Trader's attitude toward a character, 0-100.
     * @param {string} traderId
     * @param {object|string} [actor]  Defaults to the caller's assigned character.
     * @returns {number}
     */
    getAttitude(traderId, actor) {
      requireGM("getAttitude");
      return getAttitude(traderOrThrow(traderId), characterOrThrow(actor));
    },

    /** What a character has ever spent with a Trader. GM-only. */
    getSpend(traderId, actor) {
      requireGM("getSpend");
      return spendFor(traderOrThrow(traderId), characterOrThrow(actor));
    },

    /**
     * A Trader's ledger, newest first. GM-only: it is every character's dealings.
     * @param {string} traderId
     * @param {{actor?: object|string, limit?: number}} [options]  Narrow to one character.
     * @returns {object[]}  Ledger entries, as `data/ledger.mjs` documents them.
     */
    getLedger(traderId, { actor, limit } = {}) {
      requireGM("getLedger");
      const ledger = ledgerOf(traderOrThrow(traderId));
      const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : Infinity;
      if ( actor ) return entriesFor(ledger, characterOrThrow(actor).id, max);
      return ledger.slice(0, max);
    },

    /**
     * Every archetype, built-in then saved. GM-only, like the manager it serves.
     * @returns {object[]}
     */
    listArchetypes() {
      requireGM("listArchetypes");
      return listArchetypes();
    },

    /**
     * A Trader's stock, with each line's shop settings. GM-only and unfiltered — this is the
     * GM's own view, including lines gated behind an attitude threshold.
     * @param {string} traderId
     * @returns {object[]}
     */
    getStock(traderId) {
      requireGM("getStock");
      return stockEntries(traderOrThrow(traderId)).map(({ id, item, line }) => ({
        id, uuid: item.uuid, name: item.name, img: item.img, type: item.type,
        quantity: item.system?.quantity ?? 0, ...line
      }));
    },

    /**
     * The exact payload a shop renders from, for one character at one Trader.
     *
     * The one read that works from either side: a GM builds it locally, a player asks a GM for
     * it. Filtered and priced for that character, so it is safe to hand to a player.
     * @param {string} traderId
     * @param {object|string} [actor]
     * @returns {Promise<object>}
     */
    async getShopContext(traderId, actor, { payer } = {}) {
      const character = characterOrThrow(actor);
      const payerId = idOf(payer);
      if ( game.user.isGM ) {
        const trader = traderOrThrow(traderId);
        return buildShopContext(trader, character, {
          payer: resolvePayer({ actor: character, payerId }, game.user),
          user: game.user
        });
      }
      return askGM(QUERIES.context, { traderId, actorId: character.id, payerId });
    },

    /** Whether a GM is available to answer — i.e. whether a shop can be opened at all. */
    gmAvailable() {
      return gmAvailable();
    },

    /* ---------------------------------------- */
    /*  Write — GM only                         */
    /* ---------------------------------------- */

    /**
     * Create a Trader.
     * @param {{name?: string, img?: string, greeting?: string, startingAttitude?: number}} [data]
     * @returns {Promise<object>}  The new actor.
     */
    async createTrader(data = {}) {
      requireGM("createTrader");
      return createTrader(data);
    },

    /** Copy a Trader, stock and all, without its opinion of anyone. */
    async duplicateTrader(idOrUuid) {
      requireGM("duplicateTrader");
      return duplicateTrader(idOrUuid);
    },

    /** Delete a Trader. */
    async deleteTrader(idOrUuid) {
      requireGM("deleteTrader");
      return deleteTrader(idOrUuid);
    },

    /**
     * Add stock from item uuids. Repeats raise the existing line rather than adding a row.
     * @param {string} traderId
     * @param {string|string[]} uuids
     * @param {{qty?: number, line?: object}} [options]
     * @returns {Promise<{created: object[], raised: object[], failed: string[]}>}
     */
    async addStock(traderId, uuids, options = {}) {
      requireGM("addStock");
      const list = Array.isArray(uuids) ? uuids : [uuids];
      return addStockItems(traderOrThrow(traderId), list, options);
    },

    /** Remove one stock line. */
    async removeStock(traderId, itemId) {
      requireGM("removeStock");
      const trader = traderOrThrow(traderId);
      if ( !trader.items.get(itemId) ) throw new Error(t("error.stockGone"));
      await trader.deleteEmbeddedDocuments("Item", [itemId]);
      return true;
    },

    /**
     * Change one stock line's shop settings — quantity, unlimited, price override, reveal
     * threshold, restock baseline.
     * @param {string} traderId
     * @param {string} itemId
     * @param {object} patch
     * @returns {Promise<object>}  The updated item.
     */
    async setStockLine(traderId, itemId, patch = {}) {
      requireGM("setStockLine");
      const trader = traderOrThrow(traderId);
      const item = trader.items.get(itemId);
      if ( !item ) throw new Error(t("error.stockGone"));
      const { quantity, ...line } = patch;
      if ( quantity !== undefined ) {
        await item.update({ "system.quantity": Math.max(0, Math.round(Number(quantity) || 0)) });
      }
      if ( Object.keys(line).length ) {
        // Merged onto the sanitized current line, so a caller may patch one field without
        // having to restate the rest — and so an unrecognised field cannot land in the flag.
        await item.update({ [`flags.${MODULE_ID}`]: sanitizeLine({ ...stockLine(item), ...line }) });
      }
      return item;
    },

    /** Refill a Trader's shelves now, whatever its restock mode says. */
    async restock(traderId) {
      requireGM("restock");
      return restockTrader(traderOrThrow(traderId));
    },

    /** Empty a Trader's ledger. Receipts already posted to chat are untouched. */
    async clearLedger(traderId) {
      requireGM("clearLedger");
      await clearLedger(traderOrThrow(traderId));
      return true;
    },

    /**
     * Give a Trader an archetype's buy filter, restock rule and starting attitude — and, with
     * `stock: true`, fill its shelves from the archetype's recipe too.
     * @param {string} traderId
     * @param {string} archetypeId
     * @param {{stock?: boolean}} [options]
     * @returns {Promise<{archetype: object, stock: object|null}>}
     */
    async applyArchetype(traderId, archetypeId, { stock = false } = {}) {
      requireGM("applyArchetype");
      const trader = traderOrThrow(traderId);
      const archetype = getArchetype(archetypeId);
      if ( !archetype ) throw new Error(t("error.noArchetype"));
      await applyArchetype(trader, archetype);
      return { archetype, stock: stock ? await stockFromRecipe(trader, archetype.recipe) : null };
    },

    /**
     * Save a Trader's setup as an archetype.
     * @param {string} traderId
     * @param {{name: string, recipe?: object}} options  `recipe` is the stock recipe to record;
     *   without one the archetype stocks nothing when applied with stock.
     * @returns {Promise<object>}  The saved archetype.
     */
    async saveArchetype(traderId, { name, recipe } = {}) {
      requireGM("saveArchetype");
      const trader = traderOrThrow(traderId);
      return saveArchetype(archetypeFromTrader({
        id: foundry.utils.randomID(),
        name: name ?? trader.name,
        data: traderData(trader),
        recipe
      }));
    },

    /** Delete a saved archetype. Built-ins cannot be deleted; asking returns false. */
    async deleteArchetype(archetypeId) {
      requireGM("deleteArchetype");
      return deleteArchetype(archetypeId);
    },

    /**
     * A Trader as export data — the object the manager downloads. Stock travels whole; attitudes,
     * spend and the ledger never do.
     * @param {string} traderId
     * @returns {object}
     */
    exportTrader(traderId) {
      requireGM("exportTrader");
      const trader = traderOrThrow(traderId);
      return exportTrader(trader.toObject(), {
        moduleVersion: game.modules.get(MODULE_ID)?.version ?? "",
        exportedAt: new Date().toISOString()
      });
    },

    /**
     * Create a Trader from export data, as an object or the file's text.
     * @param {object|string} data
     * @returns {Promise<object>}  The new Trader.
     * @throws {Error}  Naming what is wrong with the file.
     */
    async importTrader(data) {
      requireGM("importTrader");
      const { actor, error } = await importTrader(data);
      if ( error ) throw new Error(t(`error.import.${error}`));
      return actor;
    },

    /**
     * Set a Trader's attitude toward a character.
     * @returns {Promise<{from: number, to: number, changed: boolean, vetoed: boolean}>}
     */
    async setAttitude(traderId, actor, value, options = {}) {
      requireGM("setAttitude");
      return setAttitude(traderOrThrow(traderId), characterOrThrow(actor), value, options);
    },

    /** Nudge a Trader's attitude toward a character by a delta. */
    async adjustAttitude(traderId, actor, delta, options = {}) {
      requireGM("adjustAttitude");
      return nudgeAttitude(traderOrThrow(traderId), characterOrThrow(actor), delta, options);
    },

    /** Post a Trader's card to chat. */
    async postTraderCard(idOrUuid, options = {}) {
      requireGM("postTraderCard");
      return postTraderCard(idOrUuid, options);
    },

    /** Open the GM's Trader Manager. */
    openManager() {
      requireGM("openManager");
      return TraderManagerApp.launch();
    },

    /* ---------------------------------------- */
    /*  Trading — anyone, through the GM        */
    /* ---------------------------------------- */

    /**
     * Open a shop window.
     * @param {string} traderId
     * @param {{actor?: object|string, payer?: object|string}} [options]  `payer` is a Group to pay
     *   from; the character's own purse when omitted.
     * @returns {Promise<object|null>}  The ShopApp, or null if it could not open.
     */
    async openShop(traderId, options = {}) {
      return ShopApp.open({ traderId, ...options });
    },

    /**
     * Buy from a Trader.
     *
     * Routed through the same authoritative path a player's shop uses, so a macro is validated
     * identically — it cannot buy what is not there, pay a price it chose, or exceed a purse.
     * @param {object} params
     * @param {string} params.traderId
     * @param {object|string} [params.actor]
     * @param {{id: string, qty: number}[]} params.lines
     * @returns {Promise<object>}  The settlement result.
     */
    async buy({ traderId, actor, payer, lines } = {}) {
      return api.trade({ traderId, actor, payer, mode: "trade", buy: lines, sell: [] });
    },

    /** Sell to a Trader. Same path, same validation. */
    async sell({ traderId, actor, payer, lines } = {}) {
      return api.trade({ traderId, actor, payer, mode: "trade", buy: [], sell: lines });
    },

    /**
     * Barter goods against goods, with optional coin to balance.
     * @param {object} params
     * @param {string} params.traderId
     * @param {object|string} [params.actor]
     * @param {{id: string, qty: number}[]} params.take   Trader goods wanted.
     * @param {{id: string, qty: number}[]} params.give   Character goods offered.
     * @param {number} [params.goldCp]
     * @returns {Promise<object>}
     */
    async barter({ traderId, actor, payer, take, give, goldCp = 0 } = {}) {
      return api.trade({
        traderId, actor, payer, mode: "barter", buy: take, sell: give, goldCp
      });
    },

    /**
     * The one call all three of the above go through.
     *
     * Exposed because a caller doing both halves at once — selling the old sword toward the new
     * one — needs a single settlement, and splitting it into `buy` then `sell` would fail the
     * first for want of funds the second provides.
     * @param {object} intent
     * @returns {Promise<object>}
     */
    async trade({ traderId, actor, payer, mode = "trade", buy = [], sell = [], goldCp = 0 } = {}) {
      const character = characterOrThrow(actor);
      return askGM(QUERIES.trade, {
        traderId,
        actorId: character.id,
        // A Group to pay from. Only an id crosses the wire; the GM decides whether it may be used.
        payerId: idOf(payer),
        mode,
        buy: normaliseLines(buy),
        sell: normaliseLines(sell),
        goldCp: Math.max(0, Math.round(Number(goldCp) || 0))
      });
    }
  };

  return Object.freeze(api);
}

/**
 * An actor's id from a document, an id or a uuid, or undefined for nothing — the shape every
 * `payerId` takes on the wire.
 * @param {object|string} [actor]
 * @returns {string|undefined}
 */
function idOf(actor) {
  if ( !actor ) return undefined;
  return typeof actor === "string" ? actor : actor.id;
}

/**
 * Coerce a caller's lines into the shape the authoritative path expects.
 *
 * Tolerant of a bare id or an id-and-quantity, because a macro author will write whichever
 * feels natural, and being strict here buys nothing — the settlement path validates every id
 * anyway.
 * @param {Array} lines
 * @returns {{id: string, qty: number}[]}
 */
function normaliseLines(lines) {
  return (Array.isArray(lines) ? lines : [lines])
    .filter(Boolean)
    .map(line => typeof line === "string"
      ? { id: line, qty: 1 }
      : { id: line.id, qty: Math.max(1, Math.round(Number(line.qty) || 1)) });
}

/**
 * Install the API on the module entry.
 *
 * Called at `ready` rather than `init`, because several methods reach for `game.actors` and a
 * consumer calling one during `init` would get an empty world rather than an error — which is
 * a worse failure than the method not existing yet.
 * @returns {object}  The API, for the `ready` hook's payload.
 */
export function registerApi() {
  const api = buildApi();
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = api;
  log(`api installed (${Object.keys(api).length} members, ${Object.keys(HOOKS).length} hooks)`);
  return api;
}
