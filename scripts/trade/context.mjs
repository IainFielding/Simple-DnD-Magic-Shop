import { HOOKS, fireCancellableHook, log, normalizeRarity, t } from "../config.mjs";
import { attitudeTier } from "../data/attitude.mjs";
import { formatCp, resolveMultipliers, totalCp } from "../data/pricing.mjs";
import { getTrader } from "../data/registry.mjs";
import { acceptsItem, availableQty, effectiveValueCp, lineVisible } from "../data/stock.mjs";
import { getAttitude, purse, stockEntries, traderData } from "../data/trader.mjs";
import { QUERIES, defineQuery } from "./queries.mjs";

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
 * @returns {object}  JSON-serialisable; it crosses a socket.
 */
export function buildShopContext(trader, actor) {
  const data = traderData(trader);
  const attitude = getAttitude(trader, actor);
  const chaMod = actor.system?.abilities?.cha?.mod ?? 0;

  // One multiplier pair for the whole basket: Favour does not vary line by line, so computing
  // it per item would be waste — and `resolveMultipliers` fires `prePrice`, which a listener
  // would then see once per line for no reason.
  const multipliers = resolveMultipliers({ trader, actor, chaMod, attitude });

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
      // Coin by denomination, so the barter boxes can each cap at what the character holds of
      // that coin. The character's own purse, which their client could read anyway.
      currency: Object.fromEntries(Object.keys(CONFIG.DND5E?.currencies ?? {})
        .map(d => [d, Math.max(0, Math.floor(Number(actor.system?.currency?.[d]) || 0))]))
    },
    attitude: attitudeTier(attitude),
    multipliers: {
      buy: multipliers.buy,
      sell: multipliers.sell,
      favour: multipliers.favour,
      // Rounded for display; the arithmetic always uses the unrounded values.
      buyLabel: multipliers.buy.toFixed(2),
      sellLabel: multipliers.sell.toFixed(2)
    },
    stock: visibleStock(trader, attitude, multipliers),
    pack: sellableInventory(trader, actor, multipliers)
  };
}

/**
 * The Trader's shelves as this character sees them.
 *
 * Filtered *here*, on the GM's client — see the class comment. An unpriced line is dropped
 * too: it cannot be bought, and showing a shelf item with no price only invites a click that
 * does nothing.
 * @returns {object[]}
 */
function visibleStock(trader, attitude, multipliers) {
  const out = [];
  for ( const { id, item, line } of stockEntries(trader) ) {
    if ( !lineVisible(line, attitude) ) continue;
    const valueCp = effectiveValueCp(item, line);
    if ( valueCp <= 0 ) continue;

    const qty = availableQty(item, line);
    if ( qty <= 0 ) continue;

    const buyCp = Math.max(1, Math.round(valueCp * multipliers.buy));
    out.push({
      id,
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      type: item.type,
      rarity: normalizeRarity(item.system?.rarity),
      // `Infinity` does not survive JSON, so an unlimited line says so with a flag and a
      // quantity the UI never shows.
      unlimited: qty === Infinity,
      qty: qty === Infinity ? 0 : qty,
      valueCp,
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
 * stop them.
 * @returns {object[]}
 */
function sellableInventory(trader, actor, multipliers) {
  const filter = traderData(trader).buyFilter;
  const out = [];

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

    const sellCp = accepted ? Math.max(1, Math.round(valueCp * multipliers.sell)) : 0;
    out.push({
      id: item.id,
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      type: item.type,
      rarity: normalizeRarity(item.system?.rarity),
      qty,
      valueCp,
      sellCp,
      price: accepted ? formatCp(sellCp) : "",
      equipped: !!item.system?.equipped,
      blocked: !accepted,
      blockedWhy: accepted ? null : t(`reject.${reason}`)
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/* -------------------------------------------- */
/*  The query                                   */
/* -------------------------------------------- */

defineQuery(QUERIES.context, async (data, { user }) => {
  const { trader, actor } = resolveParties(data, user);

  // A shop opening is worth a hook: a module might want to refuse one (a curfew, a faction
  // grudge, a quest state). Fired on the GM's client, where a veto can actually be trusted.
  if ( !fireCancellableHook(HOOKS.preOpenShop, { trader, actor, user }) ) {
    throw new Error(t("error.shopRefused"));
  }

  log(`shop context for "${actor.name}" at "${trader.name}"`);
  return buildShopContext(trader, actor);
});
