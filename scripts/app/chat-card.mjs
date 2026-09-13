import { HOOKS, MODULE_ID, fireHook, log, t, tpl } from "../config.mjs";
import { getTrader } from "../data/registry.mjs";
import { traderData } from "../data/trader.mjs";
import { ShopApp } from "./shop-app.mjs";

/**
 * The chat card that opens a shop.
 *
 * The GM posts it; any player clicks it and gets a shop for their own character at their own
 * prices. The card itself carries no prices at all, deliberately — two players clicking the
 * same card see two different shops, so a price on the card would be wrong for at least one of
 * them.
 */

/** The attribute the card's button carries, and the selector the handler binds to. */
const TRADER_ATTR = "data-shop-trader";

/**
 * Post a Trader's card to chat.
 *
 * Posted as a plain public message rather than as anything actor-flavoured: this is an
 * announcement that a shop is open, not an action a Trader took, and giving it a speaker would
 * put it in the Trader's voice in every chat-formatting module out there.
 * @param {string} idOrUuid
 * @param {object} [options]
 * @param {string[]} [options.whisper]  User ids to whisper to; omit for a public card.
 * @returns {Promise<object|null>}  The created ChatMessage.
 */
export async function postTraderCard(idOrUuid, { whisper } = {}) {
  const trader = getTrader(idOrUuid);
  if ( !trader ) {
    ui.notifications.warn(t("error.noTrader"));
    return null;
  }

  const content = await foundry.applications.handlebars.renderTemplate(tpl("chat/trader-card.hbs"), {
    traderId: trader.id,
    name: trader.name,
    img: trader.img,
    greeting: traderData(trader).greeting
  });

  const message = await ChatMessage.create({
    content,
    // The module's own flag, so the card is findable later and so another module can recognise
    // it without parsing HTML.
    flags: { [MODULE_ID]: { traderId: trader.id, card: "trader" } },
    ...(whisper?.length ? { whisper } : {})
  });

  fireHook(HOOKS.traderCardPosted, { trader, message });
  log(`posted a card for "${trader.name}"`);
  return message;
}

/* -------------------------------------------- */

/**
 * Wire the card's button, for every card in the log and every new one.
 *
 * `renderChatMessageHTML` fires per message, which is what makes this work for scrollback as
 * well as new arrivals. The selector is the module-specific attribute rather than a class,
 * because classes in chat are a shared namespace and a false match would open a shop from
 * somebody else's card.
 */
export function registerChatCard() {
  Hooks.on("renderChatMessageHTML", (_message, html) => {
    for ( const button of html.querySelectorAll(`[${TRADER_ATTR}]`) ) {
      button.addEventListener("click", onCardClick);
    }
  });
}

/**
 * Open the shop for whoever clicked.
 *
 * The button is disabled for the duration: opening asks a GM for a context payload, which is a
 * round trip, and an impatient double-click would otherwise fire two of them.
 * @param {MouseEvent} event
 */
async function onCardClick(event) {
  const button = event.currentTarget;
  const traderId = button.getAttribute(TRADER_ATTR);
  if ( !traderId ) return;

  button.disabled = true;
  try {
    await ShopApp.open({ traderId });
  } catch ( err ) {
    log("opening a shop from a card failed", err);
    ui.notifications.warn(err.message);
  } finally {
    button.disabled = false;
  }
}
