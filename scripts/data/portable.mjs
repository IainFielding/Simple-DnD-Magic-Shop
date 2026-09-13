import { MODULE_ID, PHYSICAL_TYPES } from "../config.mjs";
import { clampAttitude } from "./attitude.mjs";
import { sanitizeRestock } from "./restock.mjs";
import { sanitizeBuyFilter, sanitizeLine } from "./stock.mjs";

/**
 * Carrying a Trader between worlds: a file a GM can download, keep, and import somewhere else.
 *
 * The favourite shop from the last campaign, a Trader a friend built, the same black-market fence
 * in three different games — a Trader is worth more than the world it was made in.
 *
 * ## What travels, and what does not
 *
 * **Travels:** who the Trader is (name, portrait, greeting, starting attitude), how it trades (buy
 * filter, restock rule, goodwill override), its purse, and its stock as **full item data** — so a
 * shop stocked from a compendium the other world does not have still arrives whole, GM edits and
 * price overrides included.
 *
 * **Never travels:** what the Trader thinks of anyone, what anyone has spent there, or its ledger.
 * Those are about *this* world's characters, whose ids mean nothing anywhere else, and a Trader
 * that turned up in a new campaign already holding opinions of strangers would be wrong in a way
 * nobody could see.
 *
 * Pure: {@link exportTrader} takes the plain object `Actor#toObject()` returns, and
 * {@link parseTraderExport} takes whatever came out of a file. Creating the actor is
 * `data/registry.mjs#importTrader`'s job.
 */

/** Identifies a file as one of ours, so an unrelated JSON file is refused rather than half-read. */
export const EXPORT_FORMAT = `${MODULE_ID}.trader`;

/**
 * The version of the file shape. Bumped only when an old reader could not make sense of a new
 * file; adding an optional field is not a reason to bump it.
 */
export const EXPORT_VERSION = 1;

/** The most stock lines an import will create. A guard against a malformed or hostile file. */
export const IMPORT_ITEM_LIMIT = 1000;

/* -------------------------------------------- */
/*  Export                                      */
/* -------------------------------------------- */

/**
 * One stock item, stripped of everything that belongs to the world it came from.
 *
 * - `_id`, `folder`, `sort` and `ownership` are this world's bookkeeping.
 * - `_stats` is Foundry's own provenance record, rebuilt on creation — except
 *   `compendiumSource`, which is what makes a receipt's link work, so that one line is kept.
 * - `system.container` names another embedded item by id, and ids are not preserved on import;
 *   left in, an item would claim to sit inside a container that does not exist.
 * - Our own line settings are re-guarded rather than copied, so a hand-edited source cannot
 *   smuggle a malformed flag into a new world.
 *
 * Other modules' flags are kept: they are part of what makes the item that item.
 * @param {object} source  An embedded item's `toObject()` data.
 * @returns {object|null}  Null for anything that is not stockable gear.
 */
export function exportItem(source) {
  if ( !source || typeof source !== "object" || !PHYSICAL_TYPES.includes(source.type) ) return null;
  const item = structuredClone(source);
  for ( const field of ["_id", "folder", "sort", "ownership"] ) delete item[field];

  const origin = item._stats?.compendiumSource;
  item._stats = origin ? { compendiumSource: origin } : {};
  if ( item.system && typeof item.system === "object" ) item.system.container = null;

  // What a made item was made from travels too, so an imported Longsword +1 still merges with the
  // next one stocked rather than becoming a second line.
  const madeFrom = item.flags?.[MODULE_ID]?.madeFrom;
  item.flags = {
    ...(item.flags ?? {}),
    [MODULE_ID]: {
      ...sanitizeLine(item.flags?.[MODULE_ID]),
      ...(madeFrom && typeof madeFrom === "object" ? { madeFrom: sanitizeMadeFrom(madeFrom) } : {})
    }
  };
  return item;
}

/**
 * The export file's contents for one Trader.
 *
 * @param {object} source                 The Trader's `toObject()` data.
 * @param {object} [meta]
 * @param {string} [meta.moduleVersion]   Recorded for a human reading the file; never enforced.
 * @param {string} [meta.exportedAt]      An ISO timestamp, injected so a test can pin it.
 * @returns {object}  JSON-serialisable.
 */
export function exportTrader(source, { moduleVersion = "", exportedAt = "" } = {}) {
  const flags = source?.flags?.[MODULE_ID] ?? {};
  const restock = sanitizeRestock(flags.restock);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    moduleVersion,
    exportedAt,
    trader: {
      name: typeof source?.name === "string" ? source.name : "",
      img: typeof source?.img === "string" ? source.img : "",
      greeting: typeof flags.greeting === "string" ? flags.greeting : "",
      startingAttitude: Number.isFinite(Number(flags.startingAttitude))
        ? clampAttitude(flags.startingAttitude) : null,
      buyFilter: sanitizeBuyFilter(flags.buyFilter),
      // The restock *rule* travels; the moment it last ran is this world's clock and does not.
      restock: { mode: restock.mode, days: restock.days },
      attitudeGain: sanitizeGain(flags.attitudeGain),
      currency: sanitizeCurrency(source?.system?.currency)
    },
    items: (Array.isArray(source?.items) ? source.items : []).map(exportItem).filter(Boolean)
  };
}

/* -------------------------------------------- */
/*  Import                                      */
/* -------------------------------------------- */

/**
 * Read an export file, refusing anything that is not one.
 *
 * Takes a string or an already-parsed object. Everything in the result has been guarded, so the
 * caller can build an actor from it without checking any field again.
 *
 * Errors are **localisation key suffixes** under `error.import.`, so the message a GM sees is
 * specific ("this file is from a newer version") rather than a generic failure.
 * @param {string|object} raw
 * @returns {{ok: boolean, error: string|null, trader: object|null, items: object[]}}
 */
export function parseTraderExport(raw) {
  const fail = error => ({ ok: false, error, trader: null, items: [] });

  let data = raw;
  if ( typeof raw === "string" ) {
    try {
      data = JSON.parse(raw);
    } catch {
      return fail("notJson");
    }
  }
  if ( !data || typeof data !== "object" || data.format !== EXPORT_FORMAT ) return fail("notATrader");

  const version = Number(data.version);
  if ( !Number.isInteger(version) || version < 1 ) return fail("notATrader");
  if ( version > EXPORT_VERSION ) return fail("tooNew");

  const t = data.trader && typeof data.trader === "object" ? data.trader : {};
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if ( !name ) return fail("noName");

  const items = (Array.isArray(data.items) ? data.items : [])
    .slice(0, IMPORT_ITEM_LIMIT)
    .map(exportItem)
    .filter(item => item && typeof item.name === "string" && item.name.trim());

  return {
    ok: true,
    error: null,
    trader: {
      name,
      img: typeof t.img === "string" ? t.img : "",
      greeting: typeof t.greeting === "string" ? t.greeting : "",
      startingAttitude: t.startingAttitude === null || t.startingAttitude === undefined
        || !Number.isFinite(Number(t.startingAttitude)) ? null : clampAttitude(t.startingAttitude),
      buyFilter: sanitizeBuyFilter(t.buyFilter),
      restock: (({ mode, days }) => ({ mode, days }))(sanitizeRestock(t.restock)),
      attitudeGain: sanitizeGain(t.attitudeGain),
      currency: sanitizeCurrency(t.currency)
    },
    items
  };
}

/**
 * A file name for an export: the Trader's name made safe for any file system.
 * @param {string} name
 * @returns {string}
 */
export function exportFileName(name) {
  const slug = String(name ?? "")
    // Decompose accents and drop the marks, so "Café" becomes "cafe" rather than "caf-".
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `trader-${slug || "unnamed"}.json`;
}

/* -------------------------------------------- */

/** Only the string fields a made item records, so a hand-edited file cannot smuggle anything else in. */
function sanitizeMadeFrom(raw) {
  const out = {};
  for ( const key of ["template", "profile", "base", "spell"] ) {
    if ( typeof raw[key] === "string" && raw[key] ) out[key] = raw[key];
  }
  return out;
}

/** A purse with whole, non-negative coins of the standard denominations only. */
function sanitizeCurrency(raw) {
  const out = {};
  for ( const denomination of ["pp", "gp", "ep", "sp", "cp"] ) {
    const n = Math.floor(Number(raw?.[denomination]) || 0);
    out[denomination] = n > 0 ? n : 0;
  }
  return out;
}

/**
 * A goodwill override, or null to follow the world — the same rule as
 * `data/trader.mjs#traderData`, kept local so this file stays free of the persistence layer.
 */
function sanitizeGain(raw) {
  if ( !raw || typeof raw !== "object" ) return null;
  const per = Number(raw.cpPerPoint);
  const cap = Number(raw.capPerVisit);
  if ( !Number.isFinite(per) || !Number.isFinite(cap) ) return null;
  return { cpPerPoint: Math.max(0, Math.round(per)), capPerVisit: Math.max(0, Math.round(cap)) };
}
