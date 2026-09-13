import { HOOKS, fireHook, log, t } from "../config.mjs";
import { getTrader } from "../data/registry.mjs";
import { QUERIES, defineQuery } from "../trade/queries.mjs";
import { ShopApp } from "./shop-app.mjs";

/**
 * Showing a Trader to the whole table at once.
 *
 * The chat card is the right default — each player opens the shop when they are ready — but when
 * the party walks into a shop together, waiting for four people to find and click a card is slow.
 * This opens the shop on every connected player's screen in one go.
 *
 * Nothing about trust changes. The GM's client only asks each player's client to open a shop; each
 * one then asks the GM for its **own** context, priced for its own character, exactly as a card
 * click does. A player without an assigned character is skipped and reported, rather than shown a
 * shop for somebody else.
 */

/** How long to wait for a player's client to answer, in milliseconds. */
const SHOW_TIMEOUT = 20_000;

/**
 * Open a Trader's shop on every connected player's client.
 * @param {string} traderId
 * @returns {Promise<{opened: string[], skipped: {name: string, reason: string}[]}>}
 */
export async function showToPlayers(traderId) {
  const trader = getTrader(traderId);
  if ( !trader ) throw new Error(t("error.noTrader"));

  const players = game.users.filter(user => user.active && !user.isGM);
  const results = await Promise.all(players.map(async user => {
    try {
      const answer = await user.query(QUERIES.showShop, { traderId: trader.id }, { timeout: SHOW_TIMEOUT });
      return { user, ...answer };
    } catch ( err ) {
      log(`could not show "${trader.name}" to ${user.name}`, err);
      return { user, opened: false, reason: "noAnswer" };
    }
  }));

  const summary = {
    opened: results.filter(r => r.opened).map(r => r.user.name),
    skipped: results.filter(r => !r.opened).map(r => ({ name: r.user.name, reason: r.reason ?? "noAnswer" }))
  };
  fireHook(HOOKS.traderShown, {
    trader,
    results: results.map(r => ({ userId: r.user.id, opened: !!r.opened, reason: r.reason ?? null }))
  });
  return summary;
}

/**
 * The player's side: open the shop for this user's assigned character.
 *
 * Refuses anyone but a GM, checked against the requesting user Foundry attaches — otherwise one
 * player could pop shops open on everyone else's screen.
 */
defineQuery(QUERIES.showShop, async (data, { user }) => {
  if ( !user?.isGM ) throw new Error(t("error.gmOnly", { call: "showShop" }));
  if ( game.user.isGM ) return { opened: false, reason: "gm" };
  if ( !game.user.character ) return { opened: false, reason: "noCharacter" };
  const app = await ShopApp.open({ traderId: data?.traderId });
  return app ? { opened: true } : { opened: false, reason: "refused" };
});
