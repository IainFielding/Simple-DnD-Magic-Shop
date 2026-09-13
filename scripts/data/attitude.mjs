import { ATTITUDE_MAX, ATTITUDE_MIN, clamp, t } from "../config.mjs";

/**
 * Attitude: what one Trader thinks of one character, 0 to 100.
 *
 * Pure and injectable throughout — the Trader's stored record is passed in and a new one comes
 * back, so nothing here writes a document or reads a setting. `data/trader.mjs` owns the
 * persistence; this file owns the arithmetic and the rules.
 *
 * Attitude does two jobs. It is one of the two terms in the price model
 * ({@link module:data/pricing.favour}), worth a quarter of the Favour range; and it gates stock
 * a Trader will only show to someone it trusts ({@link module:data/stock.lineVisible}). The
 * second is where most of its felt weight lives, which is why its price effect does not need to
 * overpower Charisma to matter.
 */

/** Seconds in an in-game day, which is the unit a "visit" is measured in. */
export const DAY_SECONDS = 86_400;

/**
 * The tiers, as `[minimum, key]` in descending order. Read top-down: the first entry whose
 * minimum an attitude clears is its tier.
 *
 * Seven rather than five so the middle is not a single wide plateau where nothing a party does
 * appears to change anything. The neutral band is deliberately the widest (40-59) because 50 is
 * where everyone starts and small drifts either way should not feel like a verdict.
 */
const TIERS = [
  [90, "devoted"],
  [75, "friendly"],
  [60, "warm"],
  [40, "neutral"],
  [25, "wary"],
  [10, "cold"],
  [0, "hostile"]
];

/**
 * Clamp a stored or supplied attitude into range.
 *
 * Every read goes through this rather than trusting the stored number: a hand-edited flag, an
 * older schema, or a third-party module calling `setAttitude(trader, actor, 500)` must not be
 * able to push a character off the end of the Favour curve.
 * @param {*} value
 * @returns {number}
 */
export function clampAttitude(value) {
  return Math.round(clamp(value, ATTITUDE_MIN, ATTITUDE_MAX));
}

/**
 * The tier key for an attitude.
 * @param {number} value
 * @returns {string}  One of: hostile, cold, wary, neutral, warm, friendly, devoted.
 */
export function attitudeTierKey(value) {
  const v = clampAttitude(value);
  return TIERS.find(([min]) => v >= min)[1];
}

/**
 * The tier key and its localised label — what the meter shows in words beside the number.
 *
 * The word is not decoration. The meter's track is a red-to-green gradient, which is exactly
 * the axis a colour-blind viewer loses, so the label carries the same reading independently.
 * @param {number} value
 * @returns {{key: string, label: string, value: number}}
 */
export function attitudeTier(value) {
  const key = attitudeTierKey(value);
  return { key, label: t(`attitude.tier.${key}`), value: clampAttitude(value) };
}

/* -------------------------------------------- */
/*  Spend records and the goodwill drift        */
/* -------------------------------------------- */

/**
 * @typedef {object} SpendRecord
 * @property {number} lifetimeCp   Everything this character has ever spent here.
 * @property {number} visitCp      Spent during the current visit.
 * @property {number} visitEarned  Attitude points already awarded this visit, for the cap.
 * @property {number} visitDay     The in-game day the current visit belongs to.
 */

/** A fresh, empty spend record. */
export function emptySpend() {
  return { lifetimeCp: 0, visitCp: 0, visitEarned: 0, visitDay: 0 };
}

/**
 * Guard a stored spend record field by field, so a hand-edited flag or an older shape can never
 * break a trade.
 * @param {*} raw
 * @returns {SpendRecord}
 */
export function sanitizeSpend(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  return {
    lifetimeCp: num(r.lifetimeCp),
    visitCp: num(r.visitCp),
    visitEarned: num(r.visitEarned),
    visitDay: num(r.visitDay)
  };
}

/**
 * Which in-game day a world time falls on. The unit a visit is measured in.
 * @param {number} worldTime  `game.time.worldTime`, in seconds.
 * @returns {number}
 */
export function worldDay(worldTime) {
  const t = Number(worldTime);
  return Number.isFinite(t) ? Math.floor(t / DAY_SECONDS) : 0;
}

/**
 * Roll the visit counters over if this is a new day.
 *
 * **A visit is one in-game day, not one open window.** That matters: if a visit ended when the
 * shop was closed, a player could bank goodwill by closing and reopening the shop between every
 * purchase, because the per-visit cap would reset each time. Tying it to world time makes the
 * cap mean what it says, and makes it testable without a UI.
 * @param {SpendRecord} spend
 * @param {number} worldTime
 * @returns {SpendRecord}  The same record, or a rolled-over copy.
 */
export function startVisit(spend, worldTime) {
  const record = sanitizeSpend(spend);
  const day = worldDay(worldTime);
  if ( record.visitDay === day ) return record;
  return { ...record, visitCp: 0, visitEarned: 0, visitDay: day };
}

/**
 * Fold a purchase into a spend record and work out the goodwill it earns.
 *
 * Points are computed from the *visit total* rather than from this purchase alone, then reduced
 * by what the visit has already paid out. Two consequences, both wanted: small purchases add up
 * instead of each rounding down to nothing, and the cap cannot be beaten by splitting a basket
 * into single items.
 *
 * `cpPerPoint` of 0 switches the drift off entirely, which is what the world setting's hint
 * promises.
 * @param {object} params
 * @param {SpendRecord} params.spend
 * @param {number} params.spentCp      Copper this purchase is worth.
 * @param {number} params.worldTime
 * @param {number} params.cpPerPoint   Copper per point of attitude.
 * @param {number} params.cap          Most points one visit may earn.
 * @returns {{spend: SpendRecord, points: number}}  `points` is the delta to apply now.
 */
export function recordSpend({ spend, spentCp, worldTime, cpPerPoint, cap } = {}) {
  const record = startVisit(spend, worldTime);
  const amount = Math.max(0, Math.round(Number(spentCp) || 0));
  const next = {
    ...record,
    lifetimeCp: record.lifetimeCp + amount,
    visitCp: record.visitCp + amount
  };

  const per = Math.round(Number(cpPerPoint) || 0);
  const ceiling = Math.max(0, Math.round(Number(cap) || 0));
  if ( per <= 0 || ceiling <= 0 ) return { spend: next, points: 0 };

  const earnable = Math.min(ceiling, Math.floor(next.visitCp / per));
  const points = Math.max(0, earnable - next.visitEarned);
  next.visitEarned = next.visitEarned + points;
  return { spend: next, points };
}

/**
 * Apply a delta to an attitude, reporting what actually changed.
 *
 * The caller needs to know whether anything moved, not just the new value: a no-op must not
 * write a document or fire `attitudeChanged`, and at 100 a spending party would otherwise
 * generate a write and a hook on every single purchase forever.
 * @param {number} current
 * @param {number} delta
 * @returns {{from: number, to: number, changed: boolean}}
 */
export function adjustAttitude(current, delta) {
  const from = clampAttitude(current);
  const d = Math.round(Number(delta) || 0);
  const to = clampAttitude(from + d);
  return { from, to, changed: to !== from };
}
