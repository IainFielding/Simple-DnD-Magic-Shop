import { HOOKS, clamp, fireHook, log, pricingAnchors } from "../config.mjs";

/**
 * The pricing model: what a character pays, and what they are paid.
 *
 * Every function here is pure and exported for unit testing — no documents, no settings reads
 * except through the injectable `anchors` argument, no Foundry calls beyond the currency table.
 * docs/PLAN.md §3 carries the reasoning; this is the implementation and the invariants.
 *
 * ## The model
 *
 * One score, **Favour**, in −1 … +1, combines the two things that move a price:
 *
 * ```
 * Favour = clamp( 0.15 × chaMod  +  0.005 × (attitude − 50) , −1, +1 )
 *          └── ±0.75 from Charisma ──┘  └── ±0.25 from goodwill ──┘
 * ```
 *
 * Charisma is the dominant term by design: it contributes three times what the whole attitude
 * scale does, so one point of Charisma modifier is worth 30 points of attitude. The two
 * coefficients are chosen so the extremes land exactly on ±1 — a Charisma 20 character with a
 * devoted Trader reaches Favour 1.0 precisely, and nothing is lost to the clamp in normal play.
 * The attitude coefficient is the original brief's own `Attitude × 0.005`, re-centred on the
 * default of 50 so a stranger sits at zero rather than halfway up a slope.
 *
 * Favour then interpolates the buy and sell multipliers between three anchors — hostile at
 * Favour −1, neutral at 0, devoted at +1 (see `config.mjs#PRICING_PRESETS`).
 *
 * ## Why two curves rather than one modifier
 *
 * The brief originally specified a single `PriceModifier`, multiplied when buying and *divided*
 * when selling, with a `max(1.0, …)` floor. That floor was load-bearing, not decorative: with
 * `sell = value ÷ modifier`, any modifier below 1.0 makes the sell price *exceed* the buy price,
 * so a character could buy an item and sell it straight back at a profit — an infinite gold
 * loop. But the floor is also what silenced attitude entirely, because at Charisma +3 or better
 * `2.5 − chaMod/2` is already ≤ 1.0 and the modifier pins there whatever the attitude.
 *
 * Two independent curves with a guaranteed gap fix both at once. The gap is global, not just
 * per-Trader: the lowest buy multiplier any character can reach is above the highest sell
 * multiplier any character can reach, so buying from a devoted Trader and selling to *any*
 * Trader in the world still loses money. {@link validateAnchors} is what enforces that, and the
 * custom-anchor editor refuses to save a set that breaks it.
 *
 * ## Money
 *
 * All arithmetic is in integer **copper**. Prices, purses, running totals and barter balances
 * are all `…Cp` numbers, and conversion to a human string happens only at the display edge in
 * {@link formatCp}. Doing it any other way means floating-point gold and a shop that charges
 * 14.999999999 gp.
 */

/** Copper pieces per one gold piece, when the system's currency table cannot be read. */
const FALLBACK_CP_PER_GP = 100;

/** dnd5e's standard conversion rates (units per 1 gp), as a fallback for the same reason. */
const FALLBACK_CONVERSION = { pp: 0.1, gp: 1, ep: 2, sp: 10, cp: 100 };

/* -------------------------------------------- */
/*  Currency (pure)                             */
/* -------------------------------------------- */

/**
 * A denomination's conversion rate — how many of it make one gold piece — from the system's
 * config, with dnd5e's own rates as a fallback.
 * @param {string} denomination
 * @returns {number}
 */
function conversionRate(denomination) {
  const raw = Number(globalThis.CONFIG?.DND5E?.currencies?.[denomination]?.conversion);
  if ( Number.isFinite(raw) && raw > 0 ) return raw;
  return FALLBACK_CONVERSION[denomination] ?? 1;
}

/**
 * How many copper pieces one unit of a denomination is worth.
 *
 * Derived as `conversion(cp) / conversion(d)` rather than hard-coding 100, so a world that
 * reconfigures `CONFIG.DND5E.currencies` — a setting campaign with a different coinage — still
 * prices correctly instead of silently assuming the default table.
 * @param {string} denomination
 * @returns {number}
 */
export function copperPerUnit(denomination) {
  const cpRate = conversionRate("cp");
  const rate = conversionRate(denomination);
  if ( !Number.isFinite(cpRate) || cpRate <= 0 || !Number.isFinite(rate) || rate <= 0 ) {
    return denomination === "gp" ? FALLBACK_CP_PER_GP : 1;
  }
  return cpRate / rate;
}

/**
 * Normalise an amount of one denomination to whole copper pieces.
 * @param {number} amount
 * @param {string} [denomination]
 * @returns {number}  Whole copper; 0 for anything non-numeric.
 */
export function toCopper(amount, denomination = "gp") {
  const value = Number(amount);
  if ( !Number.isFinite(value) ) return 0;
  return Math.round(value * copperPerUnit(denomination));
}

/**
 * Sum a currency map (`{pp, gp, ep, sp, cp}`) into copper — a purse's total worth.
 * @param {Record<string, number>} currency
 * @returns {number}
 */
export function totalCp(currency) {
  let sum = 0;
  for ( const [denomination, amount] of Object.entries(currency ?? {}) ) {
    sum += toCopper(amount, denomination);
  }
  return sum;
}

/**
 * An item's own list value in copper, from its `system.price {value, denomination}`.
 * @param {{value: number, denomination?: string}|null|undefined} price
 * @returns {number}  0 for a missing or non-positive price, which means "not for sale".
 */
export function itemValueCp(price) {
  const cp = toCopper(price?.value ?? 0, price?.denomination || "gp");
  return cp > 0 ? cp : 0;
}

/**
 * Format a copper amount for display, largest denomination first ("15 gp", "7 sp 5 cp").
 *
 * Deliberately gp/sp/cp only, skipping platinum and electrum. Players quote prices in gold;
 * rendering 30 gp as "3 pp" is arithmetically right and practically baffling, and electrum is
 * a running joke rather than a unit anyone reckons in. Purses are *paid* in every denomination
 * the character holds — that is the system's job, not this function's.
 * @param {number} cp
 * @returns {string}
 */
export function formatCp(cp) {
  const value = Math.max(0, Math.round(Number(cp) || 0));
  const perGp = copperPerUnit("gp");
  const perSp = copperPerUnit("sp");
  const gp = Math.floor(value / perGp);
  const sp = Math.floor((value % perGp) / perSp);
  const rest = value % perSp;
  const parts = [];
  if ( gp ) parts.push(`${formatNumber(gp)} gp`);
  if ( sp ) parts.push(`${sp} sp`);
  // The `|| !parts.length` is what makes a price of zero render as "0 cp" rather than "".
  if ( rest || !parts.length ) parts.push(`${rest} cp`);
  return parts.join(" ");
}

/**
 * Group a large figure with the player's locale separators, so a 1,650 gp suit of plate does
 * not read as 1650 and get misread as 165.
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  try {
    return new Intl.NumberFormat(globalThis.game?.i18n?.lang ?? "en").format(n);
  } catch {
    return String(n);
  }
}

/* -------------------------------------------- */
/*  Favour and multipliers (pure)               */
/* -------------------------------------------- */

/** How much one point of Charisma modifier moves Favour. Five points reach ±0.75. */
export const CHA_WEIGHT = 0.15;

/** How much one point of attitude moves Favour, from the neutral 50. Fifty points reach ±0.25. */
export const ATTITUDE_WEIGHT = 0.005;

/** The attitude Favour is centred on: the default a Trader starts a stranger at. */
export const ATTITUDE_CENTRE = 50;

/** Charisma modifiers outside this are clamped — homebrew scores must not escape the curve. */
export const CHA_MOD_RANGE = [-5, 5];

/**
 * The Favour score for one character at one Trader: −1 (loathed and graceless) through 0 (a
 * Charisma 10 stranger) to +1 (a Charisma 20 character the Trader adores).
 * @param {object} params
 * @param {number} params.chaMod     The character's Charisma modifier.
 * @param {number} params.attitude   The Trader's attitude toward them, 0-100.
 * @returns {number}  −1 … +1.
 */
export function favour({ chaMod = 0, attitude = ATTITUDE_CENTRE } = {}) {
  const cha = clamp(chaMod, CHA_MOD_RANGE[0], CHA_MOD_RANGE[1]);
  const att = clamp(attitude, 0, 100);
  return clamp((CHA_WEIGHT * cha) + (ATTITUDE_WEIGHT * (att - ATTITUDE_CENTRE)), -1, 1);
}

/**
 * Linear interpolation. `t` is expected in 0 … 1; callers pass `|favour|`, which is already
 * clamped, so no guard is needed here.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
  return a + ((b - a) * t);
}

/**
 * The buy and sell multipliers for one character at one Trader.
 *
 * Anchors are injected rather than read from settings so this stays pure and testable; callers
 * in the live game pass `pricingAnchors()`. `favourScore` may be supplied directly when a
 * caller has already computed it for a whole basket — it is the same for every line, so
 * recomputing it per item would be waste.
 * @param {object} params
 * @param {number} [params.chaMod]
 * @param {number} [params.attitude]
 * @param {number} [params.favour]    Pre-computed Favour; overrides chaMod/attitude.
 * @param {object} [params.anchors]   A {@link module:config.PRICING_PRESETS} entry.
 * @returns {{buy: number, sell: number, favour: number}}
 */
export function priceMultipliers({ chaMod, attitude, favour: favourScore, anchors } = {}) {
  const set = anchors ?? pricingAnchors();
  const f = Number.isFinite(favourScore) ? clamp(favourScore, -1, 1) : favour({ chaMod, attitude });
  if ( f >= 0 ) {
    return {
      buy: lerp(set.neutral.buy, set.devoted.buy, f),
      sell: lerp(set.neutral.sell, set.devoted.sell, f),
      favour: f
    };
  }
  return {
    buy: lerp(set.neutral.buy, set.hostile.buy, -f),
    sell: lerp(set.neutral.sell, set.hostile.sell, -f),
    favour: f
  };
}

/**
 * Apply a multiplier to a list value, in copper.
 *
 * A priced item never becomes free: anything with a positive value costs at least 1 cp however
 * generous the multiplier. An *unpriced* item stays at 0, which every caller reads as "not for
 * sale" / "not worth buying" rather than "free".
 * @param {number} valueCp
 * @param {number} multiplier
 * @returns {number}
 */
export function applyMultiplier(valueCp, multiplier) {
  const base = Math.max(0, Math.round(Number(valueCp) || 0));
  if ( base <= 0 ) return 0;
  const mult = Number(multiplier);
  if ( !Number.isFinite(mult) || mult <= 0 ) return base;
  return Math.max(1, Math.round(base * mult));
}

/**
 * Both prices for one item in one breath, which is what every panel actually needs.
 * @param {number} valueCp                       List value in copper (override already applied).
 * @param {{buy: number, sell: number}} multipliers
 * @returns {{buyCp: number, sellCp: number}}
 */
export function pricesFor(valueCp, multipliers) {
  return {
    buyCp: applyMultiplier(valueCp, multipliers?.buy),
    sellCp: applyMultiplier(valueCp, multipliers?.sell)
  };
}

/* -------------------------------------------- */
/*  Anchor validation (pure)                    */
/* -------------------------------------------- */

/**
 * Check an anchor set against the invariants the model depends on.
 *
 * Three rules, and each one is load-bearing:
 *
 *  1. **All six positive and finite.** A zero or negative multiplier means free or
 *     negative-cost items.
 *  2. **Monotonic in Favour.** Goodwill must never make a character worse off: buy multipliers
 *     must not rise from hostile through neutral to devoted, and sell multipliers must not
 *     fall. This is also what makes rule 3 sufficient — with monotonicity the cheapest buy and
 *     the best sell both live at the devoted end, so checking there checks everywhere.
 *  3. **`devoted.buy > devoted.sell`.** The no-arbitrage rule. If the best sell multiplier ever
 *     met the best buy multiplier, a character could buy an item and sell it straight back for
 *     nothing, or for profit.
 *
 * Returns every failure rather than the first, so the custom-anchor editor can show a GM
 * everything wrong with their numbers in one pass.
 * @param {object} anchors
 * @returns {{ok: boolean, errors: string[]}}  `errors` are localisation keys below
 *   `sogrom-simple-dnd5e-magic-shop.pricing.error`.
 */
export function validateAnchors(anchors) {
  const errors = [];
  const tiers = ["hostile", "neutral", "devoted"];

  for ( const tier of tiers ) {
    for ( const side of ["buy", "sell"] ) {
      const v = Number(anchors?.[tier]?.[side]);
      if ( !Number.isFinite(v) || v <= 0 ) errors.push(`notPositive.${tier}.${side}`);
    }
  }
  // Without six usable numbers the comparisons below would be noise on top of the real fault.
  if ( errors.length ) return { ok: false, errors };

  if ( !(anchors.hostile.buy >= anchors.neutral.buy && anchors.neutral.buy >= anchors.devoted.buy) ) {
    errors.push("buyNotMonotonic");
  }
  if ( !(anchors.hostile.sell <= anchors.neutral.sell && anchors.neutral.sell <= anchors.devoted.sell) ) {
    errors.push("sellNotMonotonic");
  }
  if ( !(anchors.devoted.buy > anchors.devoted.sell) ) errors.push("arbitrage");

  return { ok: errors.length === 0, errors };
}

/**
 * The widest multipliers an anchor set can produce, for the pricing pane's preview and for the
 * property test that guards the no-arbitrage rule.
 * @param {object} anchors
 * @returns {{minBuy: number, maxSell: number, maxBuy: number, minSell: number}}
 */
export function multiplierBounds(anchors) {
  return {
    minBuy: anchors.devoted.buy,
    maxBuy: anchors.hostile.buy,
    minSell: anchors.hostile.sell,
    maxSell: anchors.devoted.sell
  };
}

/* -------------------------------------------- */
/*  Baskets and barter (pure)                   */
/* -------------------------------------------- */

/**
 * The multiplier one line actually trades at: the character's, or exactly 1 for goods that trade
 * at full value (gems, art objects, trade goods — see `data/stock.mjs#isFixedValue`).
 *
 * One function, used by the shop's running totals and by settlement alike, so the price a player
 * is shown and the price they pay can never apply the rule differently.
 * @param {number} multiplier
 * @param {boolean} [fixed]
 * @returns {number}
 */
export function lineMultiplier(multiplier, fixed = false) {
  return fixed ? 1 : multiplier;
}

/**
 * Price a basket of lines and total it.
 *
 * One shape serves buying, selling and both halves of a barter, because they differ only in
 * which multiplier applies. Each line keeps its own `unitCp` so a receipt can itemise, and the
 * caller gets the total it needs for an affordability check. A line marked `fixed` trades at full
 * value whatever the multiplier.
 * @param {{id: string, valueCp: number, qty: number, fixed?: boolean}[]} lines
 * @param {number} multiplier
 * @returns {{lines: {id: string, qty: number, unitCp: number, lineCp: number}[], totalCp: number}}
 */
export function priceBasket(lines, multiplier) {
  const out = [];
  let totalCp = 0;
  for ( const line of lines ?? [] ) {
    const qty = Math.max(0, Math.floor(Number(line?.qty) || 0));
    if ( qty <= 0 ) continue;
    const unitCp = applyMultiplier(line?.valueCp, lineMultiplier(multiplier, !!line?.fixed));
    const lineCp = unitCp * qty;
    totalCp += lineCp;
    out.push({ id: line.id, qty, unitCp, lineCp });
  }
  return { lines: out, totalCp };
}

/**
 * Settle a barter: what the Trader's goods cost, what the character's goods are worth, and
 * whether the offer covers the ask.
 *
 * The character's goods are valued at the *sell* multiplier and the Trader's at the *buy*
 * multiplier — the same rates that apply to a cash trade, so barter is never a way to dodge a
 * Trader's opinion of you. Gold may be added to either side to balance; `goldCp` is positive
 * when the character is adding coin to their own offer, negative when they are asking for
 * change back.
 * @param {object} params
 * @param {{id: string, valueCp: number, qty: number}[]} params.take   Trader goods wanted.
 * @param {{id: string, valueCp: number, qty: number}[]} params.give   Character goods offered.
 * @param {number} [params.goldCp]   Coin the character adds (+) or wants back (−).
 * @param {{buy: number, sell: number}} params.multipliers
 * @returns {{askCp: number, offerCp: number, balanceCp: number, accepted: boolean,
 *           take: object[], give: object[]}}
 */
export function barterBalance({ take, give, goldCp = 0, multipliers } = {}) {
  const asked = priceBasket(take, multipliers?.buy);
  const offered = priceBasket(give, multipliers?.sell);
  const coin = Math.round(Number(goldCp) || 0);
  const askCp = asked.totalCp;
  const offerCp = offered.totalCp + coin;
  const balanceCp = offerCp - askCp;
  return {
    askCp,
    offerCp,
    balanceCp,
    // Exactly covering the ask is a deal. A Trader has no reason to refuse full value.
    accepted: balanceCp >= 0,
    take: asked.lines,
    give: offered.lines
  };
}

/* -------------------------------------------- */
/*  Explaining a price (pure)                   */
/* -------------------------------------------- */

/**
 * Where a character's Favour comes from, term by term — what the shop's price breakdown shows.
 *
 * Uses the same weights and clamps as {@link favour}, so the parts shown always add up to the
 * figure that actually priced the goods. `clamped` says when they did not, which only happens
 * off the edge of the curve.
 * @param {object} params
 * @param {number} [params.chaMod]
 * @param {number} [params.attitude]
 * @returns {{chaMod: number, chaFavour: number, attitude: number, attitudeFavour: number,
 *   total: number, clamped: boolean}}
 */
export function favourBreakdown({ chaMod = 0, attitude = ATTITUDE_CENTRE } = {}) {
  const cha = clamp(chaMod, CHA_MOD_RANGE[0], CHA_MOD_RANGE[1]);
  const att = clamp(attitude, 0, 100);
  const chaFavour = CHA_WEIGHT * cha;
  const attitudeFavour = ATTITUDE_WEIGHT * (att - ATTITUDE_CENTRE);
  const total = favour({ chaMod, attitude });
  return {
    chaMod: Math.round(cha),
    chaFavour,
    attitude: Math.round(att),
    attitudeFavour,
    total,
    clamped: Math.abs((chaFavour + attitudeFavour) - total) > 1e-9
  };
}

/* -------------------------------------------- */
/*  Goodwill (pure)                             */
/* -------------------------------------------- */

/**
 * How much of a deal counts as *spending* for the goodwill drift.
 *
 * Only goods bought at the Trader's own prices count. Goods that trade at full value do not: a
 * character who buys a ruby and sells it straight back has spent nothing, and a purchase that
 * costs nothing must not be a way to make a Trader like you.
 *
 *  - **Trade:** what left the purse, capped at the ordinary goods bought — selling the old sword
 *    toward the new one still counts the new one, net of the sale, as before.
 *  - **Barter:** the whole offer, capped the same way.
 * @param {object} params
 * @param {"trade"|"barter"} params.mode
 * @param {number} params.costCp          Everything taken, at the prices charged.
 * @param {number} [params.fixedCostCp]   The full-value part of `costCp`.
 * @param {number} [params.netCp]         Coin paid (+) or received (−) in a trade.
 * @param {number} [params.creditCp]      A barter's whole offer.
 * @returns {number}  Copper, never negative.
 */
export function goodwillSpendCp({ mode, costCp = 0, fixedCostCp = 0, netCp = 0, creditCp = 0 } = {}) {
  const ordinary = Math.max(0, Math.round(Number(costCp) || 0) - Math.round(Number(fixedCostCp) || 0));
  const spent = mode === "barter" ? Math.round(Number(creditCp) || 0) : Math.round(Number(netCp) || 0);
  return Math.max(0, Math.min(ordinary, spent));
}

/* -------------------------------------------- */
/*  The live-game entry point                   */
/* -------------------------------------------- */

/**
 * The multipliers for a character at a Trader, with the `prePrice` hook applied.
 *
 * This is the one function in the file that is *not* pure, and it is deliberately the only one:
 * it reads the world's anchors and fires the extension hook. Everything above it can be tested
 * without a world; everything below the hook in the call chain gets whatever another module
 * decided. Keep it that way — the authoritative trade path calls this, so a bug here is a bug
 * in every price in the game.
 *
 * `prePrice` receives a mutable `multipliers` object. A listener that overwrites `buy` or `sell`
 * is honoured; one that sets nonsense is ignored, because a haggling module with an arithmetic
 * bug must not be able to hand out free items or negative prices.
 *
 * It fires **once per basket, not once per item**: the multiplier pair applies to every line a
 * character sees or trades at this Trader, so the payload names no item. A per-item override is
 * what a line's price override in the Trader Manager is for.
 * @param {object} params
 * @param {object} params.trader   The Trader actor, for the hook payload.
 * @param {object} params.actor    The shopping character, for the hook payload.
 * @param {number} params.chaMod
 * @param {number} params.attitude
 * @returns {{buy: number, sell: number, favour: number}}
 */
export function resolveMultipliers({ trader, actor, chaMod, attitude } = {}) {
  const base = priceMultipliers({ chaMod, attitude, anchors: pricingAnchors() });
  const multipliers = { buy: base.buy, sell: base.sell };
  fireHook(HOOKS.prePrice, { trader, actor, multipliers });

  for ( const side of ["buy", "sell"] ) {
    const v = Number(multipliers[side]);
    if ( Number.isFinite(v) && v > 0 ) base[side] = v;
    else if ( multipliers[side] !== base[side] ) {
      log(`a prePrice listener set an unusable ${side} multiplier (${multipliers[side]}); ignored`);
    }
  }
  return base;
}
