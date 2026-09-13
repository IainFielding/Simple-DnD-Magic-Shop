import { clamp } from "../config.mjs";
import { DAY_SECONDS, worldDay } from "./attitude.mjs";
import { sanitizeLine } from "./stock.mjs";

/**
 * Restocking: whether a Trader's shelves refill, and to what.
 *
 * Pure and time-injectable — `worldTime` is always an argument, never read from `game.time`,
 * so a test can advance a month without a world. `data/trader.mjs` owns the writes.
 */

/** The three restock modes a Trader can be set to. */
export const RESTOCK_MODES = ["manual", "time", "none"];

/** The default: the GM refills when they say so, and not otherwise. */
export function defaultRestock() {
  return { mode: "manual", days: 7, lastAt: 0 };
}

/**
 * @typedef {object} RestockConfig
 * @property {"manual"|"time"|"none"} mode
 * @property {number} days    Interval in in-game days, for `time` mode.
 * @property {number} lastAt  World time of the last restock, in seconds.
 */

/**
 * Guard a stored restock config.
 *
 * An unrecognised mode falls back to `manual` rather than `time`: a stale or hand-edited value
 * must not cause a Trader to start silently refilling itself on a schedule nobody set.
 * @param {*} raw
 * @returns {RestockConfig}
 */
export function sanitizeRestock(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const days = Number(r.days);
  const lastAt = Number(r.lastAt);
  return {
    mode: RESTOCK_MODES.includes(r.mode) ? r.mode : "manual",
    days: Number.isFinite(days) && days > 0 ? Math.round(clamp(days, 1, 3650)) : 7,
    lastAt: Number.isFinite(lastAt) && lastAt > 0 ? Math.round(lastAt) : 0
  };
}

/**
 * Whether enough in-game time has passed for a `time`-mode Trader to refill.
 *
 * Measured in whole days rather than raw seconds, so a restock lands on a day boundary and a
 * party that shops at dusk does not get a different answer from one that shops at dawn.
 *
 * `manual` and `none` are never automatically due — that is the whole distinction between them
 * and `time`. The difference between those two is the GM's Restock button, which calls
 * {@link restockPlan} directly and does not consult this.
 * @param {RestockConfig} restock
 * @param {number} worldTime
 * @returns {boolean}
 */
export function dueForRestock(restock, worldTime) {
  const config = sanitizeRestock(restock);
  if ( config.mode !== "time" ) return false;
  // A Trader created before its first restock has `lastAt: 0`, which on a world whose clock has
  // never advanced is also "now" — so day 0 with lastAt 0 correctly reports not due.
  return (worldDay(worldTime) - worldDay(config.lastAt)) >= config.days;
}

/**
 * When a `time`-mode Trader is next due, for the manager's "restocks in N days" readout.
 * @param {RestockConfig} restock
 * @param {number} worldTime
 * @returns {number|null}  Whole days remaining, 0 when due now, null when it never restocks.
 */
export function daysUntilRestock(restock, worldTime) {
  const config = sanitizeRestock(restock);
  if ( config.mode !== "time" ) return null;
  const elapsed = worldDay(worldTime) - worldDay(config.lastAt);
  return Math.max(0, config.days - elapsed);
}

/**
 * Work out what a restock would change, without changing it.
 *
 * **Refills up to `baseQty`, and never trims down to it.** A GM who hand-sets a line to 50
 * because the party emptied a caravan must not have it cut back to 10 by the next restock —
 * restocking is replenishment, not enforcement of a target. An unlimited line needs nothing.
 *
 * Returns only the lines that actually change, so the caller writes one update for a Trader
 * whose shelves are already full instead of rewriting every item.
 * @param {{id: string, item: object, line: object}[]} entries
 * @param {number} worldTime
 * @returns {{updates: {_id: string, "system.quantity": number}[],
 *            added: {itemId: string, from: number, to: number}[], lastAt: number}}
 */
export function restockPlan(entries, worldTime) {
  const updates = [];
  const added = [];
  for ( const entry of entries ?? [] ) {
    const line = sanitizeLine(entry?.line);
    if ( line.unlimited ) continue;
    const current = Number(entry?.item?.system?.quantity);
    const from = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
    if ( from >= line.baseQty ) continue;
    updates.push({ _id: entry.id, "system.quantity": line.baseQty });
    added.push({ itemId: entry.id, from, to: line.baseQty });
  }
  const stamp = Number(worldTime);
  return { updates, added, lastAt: Number.isFinite(stamp) ? Math.round(stamp) : 0 };
}

/** Re-exported so callers converting a day count to seconds do not reach past this module. */
export { DAY_SECONDS };
