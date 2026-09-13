import { ATTITUDE_MAX, ATTITUDE_MIN, clamp } from "../config.mjs";
import { attitudeTierKey, worldDay } from "./attitude.mjs";

/**
 * Haggling: talking a Trader round, as the 2024 rules' Influence action.
 *
 * A character picks a Charisma skill and makes the check against the Trader. Success warms the
 * Trader toward them; failure cools it, and they cannot try that same approach on that Trader again
 * until tomorrow. Attitude is the lever rather than the price directly, because attitude is already
 * what prices, reveals hidden stock and remembers the party — a good pitch should do all of those,
 * and a separate discount would do only one.
 *
 * Pure throughout, like `attitude.mjs`: records go in and new ones come out, and nothing here rolls
 * a die or writes a document. The roll happens on the GM's client in `trade/haggle.mjs`.
 */

/**
 * The skills a character can haggle with, as dnd5e keys them: Persuasion, Deception, Intimidation
 * and Performance — the Charisma skills the Influence action names for a humanoid.
 */
export const HAGGLE_SKILLS = Object.freeze(["per", "dec", "itm", "prf"]);

/** The Influence action's floor: DC 15, or the creature's Intelligence score if that is higher. */
export const HAGGLE_BASE_DC = 15;

/**
 * The DC for haggling with a Trader.
 * @param {number} [intelligence]  The Trader's Intelligence *score*, not modifier.
 * @returns {number}
 */
export function haggleDc(intelligence) {
  const score = Math.round(Number(intelligence));
  return Number.isFinite(score) ? Math.max(HAGGLE_BASE_DC, score) : HAGGLE_BASE_DC;
}

/**
 * Whether the Trader's mood gives the check an edge.
 *
 * The Influence action gives advantage against a Friendly creature and disadvantage against a
 * Hostile one. Our scale has seven tiers to the rules' three, so the two warmest (Friendly and
 * Devoted) count as friendly and the two coldest (Cold and Hostile) as hostile.
 * @param {number} attitude
 * @returns {"advantage"|"disadvantage"|"normal"}
 */
export function haggleEdge(attitude) {
  const tier = attitudeTierKey(attitude);
  if ( tier === "friendly" || tier === "devoted" ) return "advantage";
  if ( tier === "cold" || tier === "hostile" ) return "disadvantage";
  return "normal";
}

/**
 * Guard a character's stored haggle record: `skill -> the in-game day it was last failed`.
 *
 * Unknown skills and nonsense days are dropped, so a hand-edited flag cannot lock a character out
 * of a skill that does not exist or on a day that never comes.
 * @param {*} raw
 * @returns {Record<string, number>}
 */
export function sanitizeHaggleRecord(raw) {
  const out = {};
  if ( !raw || typeof raw !== "object" ) return out;
  for ( const skill of HAGGLE_SKILLS ) {
    const day = Number(raw[skill]);
    if ( Number.isInteger(day) && day >= 0 ) out[skill] = day;
  }
  return out;
}

/**
 * Whether a skill is locked for a character today.
 *
 * "Until tomorrow" is the next **in-game** day rather than 24 real hours, the same unit a visit is
 * measured in, so a GM who advances the clock past midnight lifts the lock as the rules intend.
 * @param {*} record
 * @param {string} skill
 * @param {number} worldTime
 * @returns {boolean}
 */
export function isHaggleLocked(record, skill, worldTime) {
  return sanitizeHaggleRecord(record)[skill] === worldDay(worldTime);
}

/**
 * A record with one skill locked for today, and any lock from an earlier day forgotten.
 * @param {*} record
 * @param {string} skill
 * @param {number} worldTime
 * @returns {Record<string, number>}
 */
export function lockHaggle(record, skill, worldTime) {
  const today = worldDay(worldTime);
  const out = {};
  for ( const [key, day] of Object.entries(sanitizeHaggleRecord(record)) ) {
    if ( day === today ) out[key] = day;
  }
  if ( HAGGLE_SKILLS.includes(skill) ) out[skill] = today;
  return out;
}

/**
 * What a haggle check does to attitude.
 * @param {boolean} success
 * @param {object} [amounts]
 * @param {number} [amounts.gain]   Points a success earns.
 * @param {number} [amounts.loss]   Points a failure costs.
 * @returns {number}  The delta: positive on success, negative or zero on failure.
 */
export function haggleDelta(success, { gain = 5, loss = 5 } = {}) {
  const span = ATTITUDE_MAX - ATTITUDE_MIN;
  const points = Math.round(clamp(success ? gain : loss, 0, span));
  return success ? points : (points ? -points : 0);
}
