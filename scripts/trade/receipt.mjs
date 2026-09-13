import { MODULE_ID, log, tpl } from "../config.mjs";
import { formatCp } from "../data/pricing.mjs";

/**
 * The chat receipt posted after a trade settles.
 *
 * Posted from the **GM's** client, because that is where settlement happens — which also makes
 * it trustworthy: a receipt is a record of what was actually written, not of what a player's
 * window was showing when they pressed the button.
 *
 * Public by default. A shop is a table event, and the party generally wants to know the wizard
 * has just spent the treasury on a staff.
 */

/**
 * Render and post a receipt.
 *
 * Failures are swallowed. A trade that has already settled must not be reported as failed
 * because chat was unhappy — the goods and the coin have moved, and throwing here would send a
 * misleading refusal back to a player whose purchase actually succeeded.
 * @param {object} receipt  From `trade/transaction.mjs#applyWrites`.
 * @returns {Promise<object|null>}  The ChatMessage, or null.
 */
export async function postReceipt(receipt) {
  try {
    const content = await foundry.applications.handlebars.renderTemplate(
      tpl("chat/receipt.hbs"),
      await receiptContext(receipt)
    );
    return await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor: receipt.actor }),
      flags: {
        [MODULE_ID]: {
          card: "receipt",
          traderId: receipt.trader.id,
          actorId: receipt.actor.id,
          netCp: receipt.netCp
        }
      }
    });
  } catch ( err ) {
    log("posting a receipt failed; the trade itself stands", err);
    return null;
  }
}

/**
 * Shape a receipt for the template.
 *
 * `paidCp` and `receivedCp` are kept as separate fields rather than one signed number, because
 * the template chooses a different sentence for each and a sign is not a sentence.
 * @param {object} receipt
 * @returns {Promise<object>}
 */
export async function receiptContext(receipt) {
  const paidCp = Math.max(0, receipt.netCp);
  const receivedCp = Math.max(0, -receipt.netCp);

  return {
    barter: receipt.mode === "barter",
    traderName: receipt.trader.name,
    traderImg: receipt.trader.img,
    actorName: receipt.actor.name,
    actorImg: receipt.actor.img,
    bought: await Promise.all(receipt.bought.map(receiptLine)),
    sold: await Promise.all(receipt.sold.map(receiptLine)),
    paidCp,
    receivedCp,
    paid: formatCp(paidCp),
    received: formatCp(receivedCp),
    // Named only when a Group's purse moved, so the party can see the fund was used — and by
    // whom, which is the question a shared purse always raises.
    payerName: receipt.payer && receipt.payer.id !== receipt.actor.id ? receipt.payer.name : "",
    // Only surfaced when goodwill actually moved: "+0 attitude" on every purchase would be
    // noise, and this is the line a player most wants to see.
    attitudeGained: receipt.attitudeGained > 0 ? receipt.attitudeGained : 0,
    attitudeTier: receipt.attitudeTier
  };
}

/**
 * One receipt line, with a clickable link to the item's compendium entry where there is one.
 *
 * The anchor is built with Foundry's own `toAnchor()` rather than hand-written markup, so it is
 * indistinguishable from any other content link in chat — it gets the same click handling, the
 * same drag behaviour, the same tooltip and the same icon, and it keeps working if Foundry
 * changes how links are wired.
 *
 * It is baked into the message's stored HTML, which is what dnd5e's own chat cards do: the
 * receipt is rendered once on the GM's client and every other client receives finished markup.
 *
 * An item that cannot be resolved renders as plain text. A receipt showing a dead link would be
 * worse than one showing none, and this is reachable in normal play — a Trader stocked with a
 * hand-made item has no compendium entry to point at.
 * @param {object} line
 * @returns {Promise<object>}
 */
async function receiptLine(line) {
  const base = { ...line, line: formatCp(line.lineCp), link: "" };
  if ( !line.uuid ) return base;

  const item = await fromUuid(line.uuid).catch(() => null);
  if ( !item?.toAnchor ) return base;

  try {
    base.link = item.toAnchor({ name: line.name }).outerHTML;
  } catch ( err ) {
    log(`could not build a link for "${line.name}"`, err);
  }
  return base;
}
