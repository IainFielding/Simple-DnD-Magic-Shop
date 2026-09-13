import { PHYSICAL_TYPES, RARITIES, clamp, normalizeRarity } from "../config.mjs";
import { copperPerUnit, itemValueCp, toCopper } from "./pricing.mjs";

/**
 * A Trader's stock lines: the per-item settings the GM controls, and the rules that decide what
 * a given character may see and sell.
 *
 * Stock is the Trader actor's **embedded Items** — real dnd5e documents, so price, rarity,
 * attunement, weight and tooltips all come for free, and `system.quantity` *is* the count. This
 * file owns only the shop-specific settings layered on top, stored in a flag on each embedded
 * item rather than in a map on the actor so they survive duplication and can never orphan.
 *
 * Every function is pure: items arrive as plain objects (a document works too — nothing here
 * calls a method on them), and nothing reads a setting or writes a document.
 *
 * ## Rarity and the "mundane" token
 *
 * A buy filter is a membership test, and a plain steel longsword has no rarity at all. Treating
 * an absent rarity as "fails the rarity filter" would stop a blacksmith buying a sword, so
 * {@link rarityToken} maps it to the explicit token `"mundane"`, which a GM can include or
 * exclude like any other. That is what makes "magic items only" and "no magic items" both
 * expressible with one mechanism.
 */

/** The extra token a buy filter can hold, for gear with no rarity of its own. */
export const MUNDANE = "mundane";

/** Every value a buy filter's rarity list may contain. */
export const FILTER_RARITIES = [MUNDANE, ...RARITIES];

/* -------------------------------------------- */
/*  Stock lines (pure)                          */
/* -------------------------------------------- */

/**
 * @typedef {object} StockLine
 * @property {boolean} unlimited    Never runs out; the tile shows an infinity badge.
 * @property {number|null} overrideCp  Forced list value in copper, before multipliers.
 * @property {number|null} revealAt    Attitude a character needs before they can see this.
 * @property {number} baseQty       The quantity a restock returns this line to.
 */

/** A stock line's defaults: a single, freely visible, normally priced item. */
export function defaultLine() {
  return { unlimited: false, overrideCp: null, revealAt: null, baseQty: 1 };
}

/**
 * Guard one stored stock line field by field, so a hand-edited flag or an older shape can never
 * break the shelf.
 *
 * `overrideCp` and `revealAt` are deliberately nullable rather than zero-defaulted: 0 is a
 * meaningful `revealAt` (visible to a Trader that loathes you) and would be a catastrophic
 * `overrideCp` (a free item). `null` is the only safe way to say "unset".
 * @param {*} raw
 * @returns {StockLine}
 */
export function sanitizeLine(raw) {
  const line = raw && typeof raw === "object" ? raw : {};
  const override = Number(line.overrideCp);
  const reveal = Number(line.revealAt);
  const base = Number(line.baseQty);
  return {
    unlimited: !!line.unlimited,
    overrideCp: Number.isFinite(override) && override > 0 ? Math.round(override) : null,
    revealAt: Number.isFinite(reveal) ? clamp(Math.round(reveal), 0, 100) : null,
    baseQty: Number.isFinite(base) && base > 0 ? Math.round(base) : 1
  };
}

/**
 * Whether a character with this attitude may see this line at all.
 *
 * Called on the **GM side**, before a context payload is built, so hidden stock never reaches
 * a player's browser rather than merely being hidden by CSS. A player who cannot see a line
 * also cannot name it in a trade intent, because the authoritative path re-checks visibility.
 * @param {StockLine} line
 * @param {number} attitude
 * @returns {boolean}
 */
export function lineVisible(line, attitude) {
  const reveal = sanitizeLine(line).revealAt;
  if ( reveal === null ) return true;
  return clamp(attitude, 0, 100) >= reveal;
}

/**
 * The list value a line prices from: the GM's override when set, else the item's own price.
 * @param {object} item   An Item document or index entry.
 * @param {StockLine} [line]
 * @returns {number}  Copper; 0 means "not for sale".
 */
export function effectiveValueCp(item, line) {
  const override = sanitizeLine(line).overrideCp;
  if ( override !== null ) return override;
  return itemValueCp(item?.system?.price);
}

/**
 * How many of a line are on the shelf. `Infinity` for an unlimited line, which every caller
 * compares against rather than special-casing.
 * @param {object} item
 * @param {StockLine} [line]
 * @returns {number}
 */
export function availableQty(item, line) {
  if ( sanitizeLine(line).unlimited ) return Infinity;
  const qty = Number(item?.system?.quantity);
  return Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0;
}

/* -------------------------------------------- */
/*  Buy filters (pure)                          */
/* -------------------------------------------- */

/**
 * @typedef {object} BuyFilter
 * @property {boolean} allowAll    Take anything; the lists are ignored.
 * @property {string[]} types      dnd5e item types accepted; empty means "any type".
 * @property {string[]} rarities   Rarity tokens accepted; empty means "any rarity".
 */

/** A Trader that buys anything, which is the friendliest default. */
export function defaultBuyFilter() {
  return { allowAll: true, types: [], rarities: [] };
}

/**
 * Guard a stored buy filter, dropping any type or rarity the system no longer knows.
 * @param {*} raw
 * @returns {BuyFilter}
 */
export function sanitizeBuyFilter(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  const list = (value, allowed) => (Array.isArray(value) ? value : [])
    .filter(v => allowed.includes(v));
  return {
    allowAll: f.allowAll !== false,
    types: list(f.types, PHYSICAL_TYPES),
    rarities: list(f.rarities, FILTER_RARITIES)
  };
}

/**
 * The rarity token an item filters as: its normalised rarity, or {@link MUNDANE}.
 * @param {object} item
 * @returns {string}
 */
export function rarityToken(item) {
  return normalizeRarity(item?.system?.rarity) || MUNDANE;
}

/**
 * Whether a Trader will buy an item, and if not, why not.
 *
 * The reason matters as much as the verdict: a greyed tile with no explanation is a bug report
 * waiting to happen, so every rejection names a localisation key the tile can show on hover.
 *
 * The two hard rules come before the GM's filter, because they are properties of the item
 * rather than preferences: a Trader cannot buy something that is not physical gear, and cannot
 * put a price on something with no value.
 * @param {object} item
 * @param {BuyFilter} [filter]
 * @param {StockLine} [line]   When selling *to* a Trader there is no line; only the item.
 * @returns {{accepted: boolean, reason: string|null}}  `reason` is a key below
 *   `sogrom-simple-dnd5e-magic-shop.reject`.
 */
export function acceptsItem(item, filter, line) {
  if ( !PHYSICAL_TYPES.includes(item?.type) ) return { accepted: false, reason: "notPhysical" };
  if ( effectiveValueCp(item, line) <= 0 ) return { accepted: false, reason: "unpriced" };

  const f = sanitizeBuyFilter(filter);
  if ( f.allowAll ) return { accepted: true, reason: null };

  if ( f.types.length && !f.types.includes(item.type) ) {
    return { accepted: false, reason: "wrongType" };
  }
  if ( f.rarities.length && !f.rarities.includes(rarityToken(item)) ) {
    return { accepted: false, reason: "wrongRarity" };
  }
  return { accepted: true, reason: null };
}

/* -------------------------------------------- */
/*  GM price-override inputs (pure)             */
/* -------------------------------------------- */

/**
 * Parse the GM's price-override inputs (a number and a denomination) into copper.
 *
 * Blank, non-numeric and non-positive all mean "no override" — never a free item. That is why
 * this returns `null` rather than 0: 0 would be stored as a price.
 * @param {string|number} value
 * @param {string} [denomination]
 * @returns {number|null}
 */
export function parsePriceInput(value, denomination = "gp") {
  const raw = String(value ?? "").trim();
  if ( !raw ) return null;
  const amount = Number(raw);
  if ( !Number.isFinite(amount) || amount <= 0 ) return null;
  const cp = toCopper(amount, denomination);
  return cp > 0 ? cp : null;
}

/**
 * Re-express copper as the largest denomination that divides it cleanly, for pre-filling the
 * override inputs: 1500 becomes 15 gp, 30 becomes 3 sp, 7 stays 7 cp.
 *
 * Without this, reopening the stock table would show a GM's "15 gp" override back to them as
 * "1500 cp", which reads as though the module had mangled it.
 * @param {number} cp
 * @returns {{value: number, denomination: string}}
 */
export function cpToPriceParts(cp) {
  const value = Math.max(0, Math.round(Number(cp) || 0));
  if ( value > 0 ) {
    for ( const denomination of ["pp", "gp", "ep", "sp"] ) {
      const per = copperPerUnit(denomination);
      if ( per > 1 && value % per === 0 ) return { value: value / per, denomination };
    }
  }
  return { value, denomination: "cp" };
}
