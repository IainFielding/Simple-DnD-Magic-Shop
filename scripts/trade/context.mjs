import {
  HOOKS, SETTINGS, fireCancellableHook, log, maxStockLines, normalizeRarity, pricingAnchors, setting, t
} from "../config.mjs";
import { attitudeTier } from "../data/attitude.mjs";
import { HAGGLE_SKILLS, haggleDc, haggleEdge, isHaggleLocked } from "../data/haggle.mjs";
import { entriesFor } from "../data/ledger.mjs";
import { canPayFrom, payableGroups } from "../data/party.mjs";
import {
  applyMultiplier, favourBreakdown, formatCp, lineMultiplier, priceMultipliers, resolveMultipliers,
  totalCp
} from "../data/pricing.mjs";
import { getTrader } from "../data/registry.mjs";
import {
  acceptsItem, availableQty, effectiveValueCp, isFixedValue, lineVisible
} from "../data/stock.mjs";
import {
  getAttitude, haggleRecordFor, ledgerOf, purse, stockEntries, traderData
} from "../data/trader.mjs";
import { QUERIES, defineQuery } from "./queries.mjs";

/**
 * How many of a character's past dealings their shop is sent. The shop shows a short history,
 * not an archive; the full ledger is the GM's, in the Trader Manager.
 */
export const HISTORY_LIMIT = 20;

/**
 * Building the payload a player's shop renders from — on the GM's client, always.
 *
 * This is the *only* thing a player's browser ever learns about a Trader. Everything the shop
 * shows is in here, already priced; nothing else is reachable. Two consequences follow, and
 * both are the point:
 *
 *  - **Hidden stock never crosses the wire.** A line gated behind an attitude threshold the
 *    character has not reached is filtered out here, so it is absent from the payload rather
 *    than present-but-hidden by CSS. Reading the network traffic reveals nothing.
 *  - **The player is told prices, not asked for them.** The payload carries `buyCp`/`sellCp`
 *    per line for display, and the trade path recomputes them from scratch anyway. A tampered
 *    client can lie about what it wants, never about what it costs.
 *
 * ## Who may shop as whom
 *
 * {@link resolveParties} is the gate. The query framework hands the handler the *requesting*
 * `User` document, so the check is "does this user actually own this character", asked against
 * Foundry's own ownership model. Without it, any player could shop out of any other player's
 * purse by passing a different actor id.
 */

/**
 * Resolve and authorise the two sides of a shop session.
 *
 * @param {object} data
 * @param {string} data.traderId   Trader actor id or uuid.
 * @param {string} data.actorId    The shopping character's id or uuid.
 * @param {object} user            The requesting User, supplied by the query framework.
 * @returns {{trader: object, actor: object}}
 * @throws {Error}  With a player-readable message. Never leaks whether a Trader exists to
 *   someone who may not use it — both cases report the same "no such Trader".
 */
export function resolveParties({ traderId, actorId }, user) {
  const trader = getTrader(traderId);
  if ( !trader ) throw new Error(t("error.noTrader"));

  const actor = resolveActor(actorId);
  if ( !actor ) throw new Error(t("error.noCharacter"));

  // The authorisation check. A GM may shop as anyone — running an NPC through a shop is a
  // normal thing for a GM to do — but a player may only use a character they own.
  if ( !user.isGM && !actor.testUserPermission(user, "OWNER") ) {
    log(`${user.name} tried to shop as "${actor.name}", which they do not own`);
    throw new Error(t("error.notYourCharacter"));
  }
  return { trader, actor };
}

/**
 * Resolve and authorise the purse a trade pays from.
 *
 * No `payerId`, or the character's own id, means the character's own purse — the default, and the
 * only choice when they belong to no Group. Anything else must be a Group the character is a
 * member of **and** the requesting user owns (see `data/party.mjs`); the check runs against the
 * framework-supplied user, so naming somebody else's Group in the payload gets a refusal, not
 * their gold.
 *
 * Called after {@link resolveParties}, which has already established the user may act as the
 * character at all.
 * @param {object} params
 * @param {object} params.actor      The character, already authorised.
 * @param {string} [params.payerId]  A Group's id or uuid.
 * @param {object} user
 * @returns {object}  The actor whose currency pays and receives.
 * @throws {Error}  With a player-readable message.
 */
export function resolvePayer({ actor, payerId }, user) {
  if ( !payerId || payerId === actor.id || payerId === actor.uuid ) return actor;
  const group = resolveActor(payerId);
  if ( !canPayFrom({ group, actor, user }) ) {
    log(`${user?.name} tried to pay for "${actor.name}" from "${group?.name ?? payerId}", which is not allowed`);
    throw new Error(t("error.notYourPurse"));
  }
  return group;
}

/** An actor from an id or a uuid, matching what the chat card and the API each carry. */
function resolveActor(idOrUuid) {
  if ( !idOrUuid ) return null;
  const direct = game.actors.get(idOrUuid);
  if ( direct ) return direct;
  const resolved = fromUuidSync(idOrUuid);
  return resolved?.documentName === "Actor" ? resolved : null;
}

/* -------------------------------------------- */
/*  The payload                                 */
/* -------------------------------------------- */

/**
 * Everything the shop UI needs, for one character at one Trader.
 *
 * @param {object} trader
 * @param {object} actor
 * @param {object} [options]
 * @param {object} [options.payer]  The purse paying, from {@link resolvePayer}; the character's own
 *                                  by default.
 * @param {object} [options.user]   Whose Groups to offer. The requesting user on the GM's side; the
 *                                  API passes the calling GM.
 * @returns {object}  JSON-serialisable; it crosses a socket.
 */
export function buildShopContext(trader, actor, { payer = actor, user = game.user } = {}) {
  const data = traderData(trader);
  const attitude = getAttitude(trader, actor);
  const chaMod = actor.system?.abilities?.cha?.mod ?? 0;

  // One multiplier pair for the whole basket: Favour does not vary line by line, so computing
  // it per item would be waste — and `resolveMultipliers` fires `prePrice`, which a listener
  // would then see once per line for no reason.
  const multipliers = resolveMultipliers({ trader, actor, chaMod, attitude });
  const fixedValue = !!setting(SETTINGS.fixedValueGoods);

  return {
    trader: {
      id: trader.id,
      uuid: trader.uuid,
      name: trader.name,
      img: trader.img,
      greeting: data.greeting,
      purseCp: totalCp(purse(trader)),
      purse: formatCp(totalCp(purse(trader)))
    },
    actor: {
      id: actor.id,
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      chaMod,
      purseCp: totalCp(actor.system?.currency),
      purse: formatCp(totalCp(actor.system?.currency)),
      // Coin by denomination. The character's own purse, which their client could read anyway;
      // the barter boxes cap against `purse.currency`, which is this unless a Group is paying.
      currency: coinsOf(actor)
    },
    // The purse this deal pays from and pays into. Everything that asks "can they afford it" reads
    // this rather than `actor`, because with a Group paying the character's own coin is beside
    // the point.
    purse: purseView(payer, actor),
    // Every purse the player could choose. Empty when the character has no Group to draw on, which
    // is what hides the choice in the shop altogether.
    purses: purseChoices(actor, payer, user),
    // This character's own dealings with this Trader, newest first. Filtered here, on the GM's
    // client, so the payload carries nobody else's trades — see data/ledger.mjs on what that is
    // and is not worth.
    history: entriesFor(ledgerOf(trader), actor.id, HISTORY_LIMIT).map(historyView),
    attitude: attitudeTier(attitude),
    multipliers: {
      buy: multipliers.buy,
      sell: multipliers.sell,
      favour: multipliers.favour,
      // Rounded for display; the arithmetic always uses the unrounded values.
      buyLabel: multipliers.buy.toFixed(2),
      sellLabel: multipliers.sell.toFixed(2)
    },
    // Why the multipliers are what they are, for the shop's price breakdown.
    pricing: pricingView({ chaMod, attitude, multipliers }),
    haggle: haggleView(trader, actor, attitude),
    stock: visibleStock(trader, attitude, multipliers, fixedValue),
    pack: sellableInventory(trader, actor, multipliers, fixedValue)
  };
}

/**
 * The parts a price is made of, as the shop's breakdown tooltip shows them.
 *
 * `adjusted` says a `prePrice` listener changed the multipliers. The breakdown then says so rather
 * than showing Charisma and attitude adding up to a figure they no longer produce — a house rule or
 * a guild discount is a real part of the price, and hiding it would make the numbers look wrong.
 * @param {object} params
 * @param {number} params.chaMod
 * @param {number} params.attitude
 * @param {{buy: number, sell: number}} params.multipliers  As resolved, hook included.
 * @returns {object}
 */
function pricingView({ chaMod, attitude, multipliers }) {
  const parts = favourBreakdown({ chaMod, attitude });
  const base = priceMultipliers({ favour: parts.total, anchors: pricingAnchors() });
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  return {
    ...parts,
    tier: attitudeTier(attitude).label,
    buy: multipliers.buy,
    sell: multipliers.sell,
    adjusted: !near(base.buy, multipliers.buy) || !near(base.sell, multipliers.sell)
  };
}

/**
 * What a character can try when haggling here: the DC, the edge the Trader's mood gives, and each
 * Charisma skill with the character's bonus and whether it is locked for today.
 * @param {object} trader
 * @param {object} actor
 * @param {number} attitude
 * @returns {object}
 */
function haggleView(trader, actor, attitude) {
  const record = haggleRecordFor(trader, actor);
  const worldTime = game.time.worldTime;
  return {
    dc: haggleDc(trader.system?.abilities?.int?.value),
    edge: haggleEdge(attitude),
    gain: Math.max(0, Math.round(Number(setting(SETTINGS.haggleSuccess)) || 0)),
    loss: Math.max(0, Math.round(Number(setting(SETTINGS.haggleFailure)) || 0)),
    skills: HAGGLE_SKILLS.map(key => ({
      key,
      label: game.i18n.localize(CONFIG.DND5E?.skills?.[key]?.label ?? key),
      mod: Number(actor.system?.skills?.[key]?.total) || 0,
      locked: isHaggleLocked(record, key, worldTime)
    }))
  };
}

/**
 * One purse, as the shop shows it and as the staging maths reads it.
 * @param {object} payer
 * @param {object} actor
 * @returns {object}
 */
function purseView(payer, actor) {
  const cp = totalCp(payer.system?.currency);
  return {
    id: payer.id,
    name: payer.name,
    img: payer.img,
    own: payer.id === actor.id,
    purseCp: cp,
    purse: formatCp(cp),
    currency: coinsOf(payer)
  };
}

/**
 * The purses a character may pay from: their own, then each Group this user may spend from.
 * Empty when there is nothing to choose between.
 * @returns {{id: string, name: string, own: boolean, selected: boolean, purse: string}[]}
 */
function purseChoices(actor, payer, user) {
  const groups = payableGroups(game.actors, actor, user);
  if ( !groups.length ) return [];
  return [actor, ...groups].map(owner => ({
    id: owner.id,
    name: owner.name,
    own: owner.id === actor.id,
    selected: owner.id === payer.id,
    purse: formatCp(totalCp(owner.system?.currency))
  }));
}

/** Coin by denomination, whole and non-negative, for every denomination the system defines. */
function coinsOf(owner) {
  return Object.fromEntries(Object.keys(CONFIG.DND5E?.currencies ?? {})
    .map(d => [d, Math.max(0, Math.floor(Number(owner.system?.currency?.[d]) || 0))]));
}

/**
 * A ledger entry as a player's shop shows it.
 *
 * The in-game date is formatted here, on the GM's client, because it is the GM's calendar — a
 * world with a custom calendar module has it configured where the settling happens, and a
 * player's client may not render it identically.
 * @param {import("../data/ledger.mjs").LedgerEntry} entry
 * @returns {object}
 */
export function historyView(entry) {
  const net = entry.netCp;
  return {
    id: entry.id,
    when: formatWorldTime(entry.worldTime),
    barter: entry.mode === "barter",
    bought: entry.bought.map(line => ({ ...line, line: formatCp(line.lineCp) })),
    sold: entry.sold.map(line => ({ ...line, line: formatCp(line.lineCp) })),
    paid: net > 0 ? formatCp(net) : "",
    received: net < 0 ? formatCp(-net) : "",
    payerName: entry.payerName,
    attitudeGained: entry.attitudeGained
  };
}

/**
 * A world time as the world's own calendar writes it, falling back to a day count.
 *
 * Foundry v14 formats through `game.time.calendar.format`, which throws on a formatter a calendar
 * module has not registered. A ledger that failed to render because of the calendar would be a
 * poor trade for a prettier date, so any failure reads as "Day N".
 * @param {number} worldTime
 * @returns {string}
 */
export function formatWorldTime(worldTime) {
  try {
    const formatted = game.time?.calendar?.format?.(worldTime);
    if ( typeof formatted === "string" && formatted ) return formatted;
  } catch ( err ) {
    log("calendar could not format a ledger date; using a day count", err);
  }
  return t("ledger.day", { day: Math.floor((Number(worldTime) || 0) / 86_400) + 1 });
}

/**
 * The Trader's shelves as this character sees them.
 *
 * Filtered *here*, on the GM's client — see the class comment. An unpriced line is dropped
 * too: it cannot be bought, and showing a shelf item with no price only invites a click that
 * does nothing.
 * @returns {object[]}
 */
function visibleStock(trader, attitude, multipliers, fixedValue) {
  const out = [];
  for ( const { id, item, line } of stockEntries(trader) ) {
    if ( !lineVisible(line, attitude) ) continue;
    const valueCp = effectiveValueCp(item, line);
    if ( valueCp <= 0 ) continue;

    const qty = availableQty(item, line);
    if ( qty <= 0 ) continue;

    // Priced by the same function settlement uses, so the two can never round differently.
    const fixed = isFixedValue(item, fixedValue);
    const buyCp = applyMultiplier(valueCp, lineMultiplier(multipliers.buy, fixed));
    out.push({
      id,
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      type: item.type,
      subtype: subtypeOf(item),
      rarity: normalizeRarity(item.system?.rarity),
      // `Infinity` does not survive JSON, so an unlimited line says so with a flag and a
      // quantity the UI never shows.
      unlimited: qty === Infinity,
      qty: qty === Infinity ? 0 : qty,
      valueCp,
      fixed,
      buyCp,
      price: formatCp(buyCp)
    });
  }
  return out;
}

/**
 * The character's own gear, with what this Trader would pay for each piece.
 *
 * Everything sellable is listed, including what this Trader will not take — those come back
 * `blocked` with a reason, because a greyed tile that does not say why is a bug report waiting
 * to happen. Equipped and attuned items are flagged rather than withheld: selling the armour
 * you are standing in is a decision a player is allowed to make, and dnd5e itself does not
 * stop them. The flags are what let the shop *say* so — the item arrives on the Trader's shelf
 * unequipped and unattuned either way.
 * @returns {object[]}
 */
function sellableInventory(trader, actor, multipliers, fixedValue) {
  const filter = traderData(trader).buyFilter;
  const out = [];
  // A full Trader still buys what it already stocks — that merges into the line — but nothing new.
  const shelf = stockEntries(trader);
  const stocked = new Set(shelf.map(e => `${e.item.type}:${e.item.name}`));
  const full = shelf.length >= maxStockLines();

  for ( const item of actor.items ) {
    // Containers are skipped outright: selling a backpack whose contents are tracked inside it
    // would either orphan or silently sell the contents, and neither is a decision to make for
    // a player in a shop window.
    if ( item.type === "container" ) continue;

    const valueCp = effectiveValueCp(item, null);
    const { accepted, reason } = acceptsItem(item, filter, null);
    // Something with no value at all is not "refused", it is simply not merchandise; listing it
    // as a rejected tile would fill the panel with spell scrolls and class features.
    if ( !accepted && reason !== "wrongType" && reason !== "wrongRarity" ) continue;

    const qty = Math.max(0, Math.floor(Number(item.system?.quantity) || 0));
    if ( qty <= 0 ) continue;

    const noRoom = accepted && full && !stocked.has(`${item.type}:${item.name}`);
    const fixed = isFixedValue(item, fixedValue);
    const sellCp = accepted ? applyMultiplier(valueCp, lineMultiplier(multipliers.sell, fixed)) : 0;
    out.push({
      id: item.id,
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      type: item.type,
      subtype: subtypeOf(item),
      rarity: normalizeRarity(item.system?.rarity),
      qty,
      valueCp,
      fixed,
      sellCp,
      price: accepted ? formatCp(sellCp) : "",
      equipped: !!item.system?.equipped,
      attuned: !!item.system?.attuned,
      blocked: !accepted || noRoom,
      blockedWhy: !accepted ? t(`reject.${reason}`) : noRoom ? t("reject.shopFull") : null
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/**
 * An item's dnd5e subtype — "heavy" armour, a "music" tool, a "gem" — read the same way the
 * stock generator's item index reads it, so the shop's type filter and the generator's kinds
 * picker sort items into the same categories.
 * @returns {string}
 */
function subtypeOf(item) {
  const value = item.system?.type?.value;
  return typeof value === "string" ? value : "";
}

/* -------------------------------------------- */
/*  The query                                   */
/* -------------------------------------------- */

defineQuery(QUERIES.context, async (data, { user }) => {
  const { trader, actor } = resolveParties(data, user);
  const payer = resolvePayer({ actor, payerId: data?.payerId }, user);

  // A shop opening is worth a hook: a module might want to refuse one (a curfew, a faction
  // grudge, a quest state). Fired on the GM's client, where a veto can actually be trusted.
  if ( !fireCancellableHook(HOOKS.preOpenShop, { trader, actor, user }) ) {
    throw new Error(t("error.shopRefused"));
  }

  log(`shop context for "${actor.name}" at "${trader.name}"`);
  return buildShopContext(trader, actor, { payer, user });
});
