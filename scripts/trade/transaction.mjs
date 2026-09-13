import {
  HOOKS, MODULE_ID, SETTINGS, fireCancellableHook, fireHook, log, setting, t
} from "../config.mjs";
import { attitudeTier } from "../data/attitude.mjs";
import {
  applyMultiplier, barterBalance, formatCp, goodwillSpendCp, lineMultiplier, resolveMultipliers,
  totalCp
} from "../data/pricing.mjs";
import {
  acceptsItem, availableQty, effectiveValueCp, isFixedValue, lineVisible, transferData
} from "../data/stock.mjs";
import {
  bookSpend, getAttitude, purse, recordTrade, stockLine, traderData
} from "../data/trader.mjs";
import { makeEntry } from "../data/ledger.mjs";
import { serialised } from "../data/serial.mjs";
import { postReceipt } from "./receipt.mjs";
import { QUERIES, defineQuery } from "./queries.mjs";
import { resolveParties, resolvePayer } from "./context.mjs";
import { Journal, currencyDelta, reverseCurrency } from "./journal.mjs";

/**
 * Settling a trade. The authoritative path, GM-side, and the only code in the module that moves
 * anything of value.
 *
 * ## What arrives, and what is trusted
 *
 * A client sends **item ids and quantities only** — see `app/shop-state.mjs#intent`. Nothing
 * price-shaped crosses the wire, so nothing price-shaped needs validating: every figure used
 * here is derived from the Trader's own documents and the world's own pricing settings, by the
 * same functions that built the context payload. A tampered client can ask for the wrong
 * *things*; it cannot ask for the wrong *price*.
 *
 * Every id is re-checked from scratch even though the context payload was built moments ago,
 * because "moments ago" is long enough: the GM may have emptied a shelf, another player may
 * have bought the last one, or the client may simply be lying.
 *
 * ## Why it is all-or-nothing
 *
 * A partial settlement is the worst outcome available — coin taken and no item, or an item
 * handed over for free. So {@link settle} validates **everything** first, builds the complete
 * set of writes, and only then applies them. Foundry cannot make the writes themselves atomic, so
 * {@link applyWrites} records how to reverse each one as it lands, and undoes the lot if a later
 * one fails (see `trade/journal.mjs`).
 */

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Turn a raw intent into a validated, priced plan — or throw with a reason a player can read.
 *
 * @param {object} params
 * @param {object} params.trader
 * @param {object} params.actor    The character: whose goods are sold, who receives what is
 *                                 bought, and whose attitude and spend it all counts toward.
 * @param {object} [params.payer]  Whose coin pays and receives — the character, or a Group they
 *                                 may spend from (already authorised by `resolvePayer`).
 * @param {object} params.intent   `{mode, buy, sell, goldCp}` from the client.
 * @returns {object}  The plan {@link applyWrites} consumes.
 */
export function planTrade({ trader, actor, payer = actor, intent }) {
  const mode = intent?.mode === "barter" ? "barter" : "trade";
  const attitude = getAttitude(trader, actor);
  const chaMod = actor.system?.abilities?.cha?.mod ?? 0;
  const multipliers = resolveMultipliers({ trader, actor, chaMod, attitude });
  const filter = traderData(trader).buyFilter;
  // Read once per plan: gems, art and trade goods at full value is a world rule.
  const fixedValue = !!setting(SETTINGS.fixedValueGoods);

  const buying = [];
  const selling = [];

  /* --- What the character is taking from the Trader --------------------- */
  for ( const request of intent?.buy ?? [] ) {
    const qty = wholeQty(request?.qty);
    if ( qty <= 0 ) continue;

    const item = trader.items.get(request?.id);
    if ( !item ) throw new Error(t("error.stockGone"));

    const line = stockLine(item);

    // Visibility is re-checked, not assumed. Without this, a client could name a reveal-gated
    // id it learned some other way and buy something it was never offered.
    if ( !lineVisible(line, attitude) ) throw new Error(t("error.stockGone"));

    const available = availableQty(item, line);
    if ( qty > available ) {
      throw new Error(t("error.notEnoughStock", { name: item.name, qty: available }));
    }

    const valueCp = effectiveValueCp(item, line);
    if ( valueCp <= 0 ) throw new Error(t("error.notForSale", { name: item.name }));

    const fixed = isFixedValue(item, fixedValue);
    buying.push({
      id: item.id,
      item,
      line,
      name: item.name,
      img: item.img,
      qty,
      unitCp: applyMultiplier(valueCp, lineMultiplier(multipliers.buy, fixed)),
      valueCp,
      fixed,
      unlimited: line.unlimited,
      available
    });
  }

  /* --- What the character is handing over -------------------------------- */
  for ( const request of intent?.sell ?? [] ) {
    const qty = wholeQty(request?.qty);
    if ( qty <= 0 ) continue;

    const item = actor.items.get(request?.id);
    if ( !item ) throw new Error(t("error.itemGone"));

    const held = Math.max(0, Math.floor(Number(item.system?.quantity) || 0));
    if ( qty > held ) throw new Error(t("error.notEnoughHeld", { name: item.name, qty: held }));

    // The Trader's buy filter is enforced here too, for the same reason as visibility: the
    // client greys these out, but the client is not the authority on what a Trader will take.
    const { accepted, reason } = acceptsItem(item, filter, null);
    if ( !accepted ) throw new Error(t(`reject.${reason}`));

    const valueCp = effectiveValueCp(item, null);
    const fixed = isFixedValue(item, fixedValue);
    selling.push({
      id: item.id,
      item,
      name: item.name,
      img: item.img,
      qty,
      unitCp: applyMultiplier(valueCp, lineMultiplier(multipliers.sell, fixed)),
      valueCp,
      fixed,
      held
    });
  }

  if ( !buying.length && !selling.length ) throw new Error(t("error.nothingStaged"));

  // The part of the purchase that trades at full value, which earns no goodwill.
  const fixedCostCp = buying.filter(l => l.fixed).reduce((sum, l) => sum + (l.unitCp * l.qty), 0);

  /* --- The money -------------------------------------------------------- */
  // `actorPurseCp` keeps its name for the plan's consumers, but it is the *paying* purse: with a
  // Group paying, what the character carries is beside the point.
  const actorPurseCp = totalCp(payer.system?.currency);
  const traderPurseCp = totalCp(purse(trader));

  const plan = {
    mode, trader, actor, payer, buying, selling, multipliers, attitude,
    actorPurseCp, traderPurseCp, fixedCostCp
  };

  if ( mode === "barter" ) return planBarter(plan, intent);
  return planCash(plan);
}

/**
 * A cash trade: the purchase and the sale net off, and whoever ends up owing pays.
 *
 * Settling both halves together is not a convenience — it is what lets a character with 10 gp
 * trade a 250 gp sword for an 80 gp shield, which is an entirely ordinary thing to want. Making
 * them two transactions would fail the first one for want of funds the second provides.
 */
function planCash(plan) {
  const costCp = plan.buying.reduce((sum, l) => sum + (l.unitCp * l.qty), 0);
  const creditCp = plan.selling.reduce((sum, l) => sum + (l.unitCp * l.qty), 0);
  const netCp = costCp - creditCp;

  if ( netCp > plan.actorPurseCp ) throw shortError(plan, netCp - plan.actorPurseCp);
  // The Trader's purse is a real constraint: a village blacksmith cannot buy a 5,000 gp blade
  // however much they might like to.
  if ( netCp < 0 && Math.abs(netCp) > plan.traderPurseCp ) {
    throw new Error(t("error.traderCannotAfford", {
      name: plan.trader.name, purse: formatCp(plan.traderPurseCp)
    }));
  }

  return { ...plan, costCp, creditCp, netCp, goldCp: 0, accepted: true };
}

/**
 * A barter: goods against goods, with coin allowed on the character's side to balance.
 *
 * Valued at exactly the same rates a cash trade would use, so barter is never a way to dodge a
 * Trader's opinion of you.
 */
function planBarter(plan, intent) {
  // Real coins when the client names them — the shop does — otherwise a plain copper amount,
  // which is what the API's `barter({goldCp})` sends. A client-supplied `goldCp` is only ever
  // used when no coins are given; alongside coins it is recomputed here and never trusted.
  const coins = sanitizeCoins(intent?.coins);
  let goldCp;
  if ( coins ) {
    const held = plan.payer.system?.currency ?? {};
    for ( const [denomination, count] of Object.entries(coins) ) {
      const have = Math.max(0, Math.floor(Number(held[denomination]) || 0));
      if ( count > have ) {
        throw new Error(t("error.notEnoughCoin", { qty: have, denomination }));
      }
    }
    goldCp = totalCp(coins);
  } else {
    goldCp = Math.max(0, Math.round(Number(intent?.goldCp) || 0));
    if ( goldCp > plan.actorPurseCp ) throw shortError(plan, goldCp - plan.actorPurseCp);
  }

  const balance = barterBalance({
    take: plan.buying.map(l => ({ id: l.id, valueCp: l.valueCp, qty: l.qty, fixed: l.fixed })),
    give: plan.selling.map(l => ({ id: l.id, valueCp: l.valueCp, qty: l.qty, fixed: l.fixed })),
    goldCp,
    multipliers: plan.multipliers
  });

  if ( !balance.accepted ) {
    throw new Error(t("error.barterRefused", { short: formatCp(Math.abs(balance.balanceCp)) }));
  }

  // A barter moves the coin the character offered and nothing back. Change is deliberately not
  // given: the offer was theirs to make, and handing coin back would turn every generous swap
  // into a cash trade the Trader never agreed to.
  return {
    ...plan,
    costCp: balance.askCp,
    creditCp: balance.offerCp,
    netCp: goldCp,
    goldCp,
    coins,
    accepted: true
  };
}

/**
 * The refusal for a purse that cannot cover a deal — naming the Group when it is the Group's
 * purse that is short, because "you are 40 gp short" is wrong when your own pockets are full.
 * @param {object} plan
 * @param {number} shortCp
 * @returns {Error}
 */
function shortError(plan, shortCp) {
  const short = formatCp(shortCp);
  if ( plan.payer && plan.payer.id !== plan.actor.id ) {
    return new Error(t("error.purseShort", { name: plan.payer.name, short }));
  }
  return new Error(t("error.cannotAfford", { short }));
}

/**
 * Guard a staged-coins map: known denominations only, whole non-negative counts.
 * @param {*} raw
 * @returns {Record<string, number>|null}  Null when nothing is being offered.
 */
function sanitizeCoins(raw) {
  if ( !raw || typeof raw !== "object" ) return null;
  const known = Object.keys(CONFIG.DND5E?.currencies ?? { pp: 1, gp: 1, ep: 1, sp: 1, cp: 1 });
  const out = {};
  for ( const denomination of known ) {
    const count = Math.floor(Number(raw[denomination]) || 0);
    if ( count > 0 ) out[denomination] = count;
  }
  return Object.keys(out).length ? out : null;
}

/** A request's quantity as a whole positive number, or 0. */
function wholeQty(raw) {
  const n = Math.floor(Number(raw) || 0);
  return n > 0 ? n : 0;
}

/* -------------------------------------------- */
/*  Applying                                    */
/* -------------------------------------------- */

/**
 * Write a validated plan — all of it, or none of it.
 *
 * ## Ordering
 *
 *  1. **Coin first.** Currency is the only thing that can fail for a reason validation could
 *     miss (a concurrent purchase by the same character on another client), and it is the
 *     cheapest thing to have not happened.
 *  2. **Then the Trader's stock**, decremented or removed, and what the character sold added.
 *  3. **Then the character's items** — removals, then the new items.
 *
 * ## When a write fails partway
 *
 * Every write records how to reverse itself as it lands (`trade/journal.mjs`), and a failure
 * replays those in reverse before the refusal goes back to the player. So a trade either happens
 * or leaves no trace: the character keeps their coin and their gear, the Trader its stock.
 *
 * A failure *before* anything was written is an ordinary refusal and keeps its own message — "you
 * are 4 gp short" is more use to a player than "the trade was undone". A reversal that itself
 * fails is reported to the GM by name, because by then only a person can put it right.
 *
 * Goodwill, the ledger and the receipt come after, outside the journal, and none of them can fail
 * the trade: the goods have moved, and a trade that succeeded must not be reported as refused.
 *
 * @param {object} plan  From {@link planTrade}.
 * @returns {Promise<object>}  The receipt data.
 */
export async function applyWrites(plan) {
  const journal = new Journal();
  try {
    await writeGoods(plan, journal);
  } catch ( err ) {
    if ( !journal.size ) throw err;
    const { failed } = await journal.rollback();
    // A clean rollback is the design working, so it goes to the debug log with the cause. Only a
    // rollback that could not finish is an error a GM needs to see in the console.
    log("a trade failed partway and was rolled back", err);
    if ( failed.length ) {
      console.error(`${MODULE_ID} | a trade failed partway and these writes could not be undone:`, err, failed);
      ui.notifications.error(t("error.rollbackIncomplete", {
        trader: plan.trader.name,
        actor: plan.actor.name,
        parts: failed.map(f => f.label).join(", ")
      }), { permanent: true });
      throw new Error(t("error.tradeFailedPartial"), { cause: err });
    }
    throw new Error(t("error.tradeFailed"), { cause: err });
  }

  const gain = await awardGoodwill(plan);
  return {
    mode: plan.mode,
    trader: plan.trader,
    actor: plan.actor,
    payer: plan.payer ?? plan.actor,
    // Built from the plan rather than from the created documents: the plan is what knows the
    // prices, and pairing two arrays by index would break the moment one of them was filtered.
    bought: plan.buying.map(receiptLine),
    sold: plan.selling.map(receiptLine),
    costCp: plan.costCp,
    creditCp: plan.creditCp,
    netCp: plan.netCp,
    attitudeGained: gain.points,
    attitudeNow: gain.to,
    attitudeTier: attitudeTier(gain.to).label
  };
}

/**
 * Every document write a trade makes, each one journalled as it lands.
 * @param {object} plan
 * @param {Journal} journal
 */
async function writeGoods(plan, journal) {
  const { trader, actor, buying, selling } = plan;

  /* --- 1. Coin ---------------------------------------------------------- */
  await moveCoin(plan, journal);

  /* --- 2. The Trader's shelves ------------------------------------------ */
  const stockUpdates = [];
  const stockDeletes = [];
  for ( const line of buying ) {
    // An unlimited line is the point of being unlimited: it never depletes.
    if ( line.unlimited ) continue;
    const left = line.available - line.qty;
    if ( left > 0 ) stockUpdates.push({ id: line.id, qty: line.qty, left });
    else stockDeletes.push(line.id);
  }
  await takeQuantities(trader, stockUpdates, journal, "shelf");
  await deleteItems(trader, stockDeletes, journal, "shelf");

  // What the character sold goes onto the Trader's shelves, because a shop that buys things has
  // them afterwards — and because it is what lets a party come back for the sword they regret.
  if ( selling.length ) await absorbSoldItems(trader, selling, journal);

  /* --- 3. The character's pack ------------------------------------------ */
  const packUpdates = [];
  const packDeletes = [];
  for ( const line of selling ) {
    const left = line.held - line.qty;
    if ( left > 0 ) packUpdates.push({ id: line.id, qty: line.qty, left });
    else packDeletes.push(line.id);
  }
  await takeQuantities(actor, packUpdates, journal, "pack");
  await deleteItems(actor, packDeletes, journal, "pack");

  await grantBoughtItems(actor, buying, journal);
}

/**
 * Lower some embedded items' quantities, journalling the amount taken so it can be given back.
 * @param {object} owner
 * @param {{id: string, qty: number, left: number}[]} changes
 * @param {Journal} journal
 * @param {string} label
 */
async function takeQuantities(owner, changes, journal, label) {
  if ( !changes.length ) return;
  await owner.updateEmbeddedDocuments("Item", changes.map(c => ({ _id: c.id, "system.quantity": c.left })));
  journal.record(`${label}: quantities on ${owner.name}`, () => owner.updateEmbeddedDocuments("Item",
    changes.filter(c => owner.items.get(c.id)).map(c => ({
      _id: c.id,
      "system.quantity": (Number(owner.items.get(c.id).system?.quantity) || 0) + c.qty
    }))));
}

/**
 * Delete embedded items, journalling their full data so they can be recreated with the same ids —
 * which is what keeps a restored stock line's settings, and any staged intent naming it, valid.
 * @param {object} owner
 * @param {string[]} ids
 * @param {Journal} journal
 * @param {string} label
 */
async function deleteItems(owner, ids, journal, label) {
  if ( !ids.length ) return;
  const saved = ids.map(id => owner.items.get(id)?.toObject()).filter(Boolean);
  await owner.deleteEmbeddedDocuments("Item", ids);
  journal.record(`${label}: removed items on ${owner.name}`, async () => {
    const back = await owner.createEmbeddedDocuments("Item", saved, { keepId: true });
    // Refused as quietly as a grant can be; say so, so the GM is told what is still missing.
    if ( back.length !== saved.length ) throw new Error(`${saved.length - back.length} item(s) could not be restored`);
  });
}

/**
 * Create embedded items, journalling their ids so they can be removed again.
 *
 * Checks that everything asked for was actually made. A `preCreateItem` listener returning false
 * does not throw — Foundry simply creates nothing — and without this check a refused grant looked
 * like a successful trade in which the character paid and received nothing.
 * @param {object} owner
 * @param {object[]} data
 * @param {Journal} journal
 * @param {string} label
 * @returns {Promise<object[]>}
 */
async function createItems(owner, data, journal, label) {
  if ( !data.length ) return [];
  const created = await owner.createEmbeddedDocuments("Item", data);
  const ids = created.map(item => item.id);
  if ( ids.length ) {
    journal.record(`${label}: new items on ${owner.name}`,
      () => owner.deleteEmbeddedDocuments("Item", ids.filter(id => owner.items.has(id))));
  }
  if ( created.length !== data.length ) {
    throw new Error(`${data.length - created.length} item(s) could not be created on ${owner.name}`);
  }
  return created;
}

/**
 * Apply goodwill for what was spent. Never fails the trade — see {@link applyWrites}.
 *
 * Only what the character actually *spent* counts, and only on goods bought at the Trader's own
 * prices. Selling into a Trader's purse is not patronage, and crediting it would let a party farm
 * goodwill by selling junk back and forth; likewise gems and art objects, which trade at full
 * value and so can be bought and sold straight back at no cost. See `pricing.mjs#goodwillSpendCp`.
 * @param {object} plan
 * @returns {Promise<{points: number, to: number}>}
 */
async function awardGoodwill(plan) {
  const spentCp = goodwillSpendCp({
    mode: plan.mode,
    costCp: plan.costCp,
    fixedCostCp: plan.fixedCostCp,
    netCp: plan.netCp,
    creditCp: plan.creditCp
  });
  if ( spentCp <= 0 ) return { points: 0, to: plan.attitude };
  try {
    const gain = await bookSpend(plan.trader, plan.actor, spentCp);
    return { points: gain.points, to: gain.to };
  } catch ( err ) {
    log("booking goodwill failed; the trade itself stands", err);
    return { points: 0, to: plan.attitude };
  }
}

/**
 * One line of a receipt.
 *
 * `uuid` is the item's **compendium source**, not the embedded copy it was traded from. The
 * embedded one is the wrong thing to link: the Trader's copy may have been deleted by the very
 * purchase the receipt describes (buying the last of a line removes the row), and a character's
 * copy is not something the rest of the table can open. The compendium entry is durable, is
 * what a player actually wants to read, and is readable by everyone.
 *
 * An item the shop made from a magic item template links the **template** rather than the plain
 * base item it was built on: a receipt for a Flame Tongue should open the Flame Tongue.
 *
 * Falls back to the item's own uuid for something hand-made that never came from a compendium —
 * and if that does not resolve either, the receipt renders the name as plain text rather than a
 * dead link.
 * @param {object} line  A plan line from {@link planTrade}.
 * @returns {object}
 */
function receiptLine(line) {
  return {
    name: line.name,
    img: line.img,
    qty: line.qty,
    lineCp: line.unitCp * line.qty,
    uuid: line.item?.flags?.[MODULE_ID]?.enchanted?.template
      || line.item?._stats?.compendiumSource || line.item?.uuid || ""
  };
}

/**
 * Move the coin, in whichever direction the deal runs, between the Trader and the paying purse.
 *
 * The paying purse is the character's own unless a Group is paying, and it works both ways: a
 * sale made while the party fund is paying puts its proceeds in the party fund, so a character
 * selling loot for the party cannot quietly pocket it.
 *
 * Deduction goes through dnd5e's own `CurrencyManager`, which handles the part nobody should
 * reimplement: paying an exact amount out of a mixed purse, breaking a platinum piece into gold
 * when the gold runs short. Payment *to* someone is a simple addition, because there is no
 * change to make.
 *
 * Each purse write is journalled as the per-coin change it made, so a rollback gives back exactly
 * those coins without disturbing anything else the purse has done since.
 */
async function moveCoin(plan, journal) {
  const { trader, netCp, mode, goldCp, coins } = plan;
  const actor = plan.payer ?? plan.actor;
  const manager = globalThis.dnd5e?.applications?.CurrencyManager;

  // Named coins move as those coins: three platinum offered leave the purse as three platinum
  // and arrive in the Trader's as three platinum, with no change-making in either direction.
  if ( mode === "barter" && coins ) return moveNamedCoins(actor, trader, coins, journal);

  // Barter moves only the coin the character chose to add.
  const fromActorCp = mode === "barter" ? goldCp : Math.max(0, netCp);
  const toActorCp = mode === "barter" ? 0 : Math.max(0, -netCp);

  if ( fromActorCp > 0 ) {
    await journalPurse(actor, journal, () => deduct(manager, actor, fromActorCp));
    await journalPurse(trader, journal, () => credit(trader, fromActorCp));
  }
  if ( toActorCp > 0 ) {
    await journalPurse(trader, journal, () => deduct(manager, trader, toActorCp));
    await journalPurse(actor, journal, () => credit(actor, toActorCp));
  }
}

/**
 * Run one purse write and journal the coins it moved.
 * @param {object} owner
 * @param {Journal} journal
 * @param {() => Promise<*>} write
 */
async function journalPurse(owner, journal, write) {
  const before = { ...(owner.system?.currency ?? {}) };
  await write();
  const delta = currencyDelta(before, owner.system?.currency);
  if ( !Object.keys(delta).length ) return;
  journal.record(`coin: ${owner.name}`, () => owner.update(reverseCurrency(owner.system?.currency, delta)));
}

/**
 * Take an amount of copper off an actor.
 *
 * `CurrencyManager.deductActorCurrency` throws on insufficient funds, which is the right
 * behaviour — validation should already have ruled it out, so reaching it means a concurrent
 * spend and the trade must not continue. The fallback path exists only for a system version
 * whose manager has moved; it is deliberately cruder (copper-only) rather than absent, because
 * silently doing nothing would hand out free goods.
 */
async function deduct(manager, actor, cp) {
  if ( manager?.deductActorCurrency ) {
    await manager.deductActorCurrency(actor, cp, "cp", { exact: false, makeChange: true });
    return;
  }
  log("dnd5e's CurrencyManager is unavailable; falling back to a copper-only deduction");
  const total = totalCp(actor.system?.currency);
  if ( cp > total ) throw new Error(t("error.cannotAfford", { short: formatCp(cp - total) }));
  await actor.update({ "system.currency": spreadCopper(total - cp) });
}

/**
 * Move specific coins from one purse to another.
 *
 * The purse is re-read at the moment of writing rather than trusted from validation, because the
 * same character can spend on another client in between; a coin that has gone since the plan was
 * made refuses the trade rather than driving a denomination negative.
 */
async function moveNamedCoins(from, to, coins, journal) {
  const fromUpdate = {};
  const toUpdate = {};
  for ( const [denomination, count] of Object.entries(coins) ) {
    const have = Math.floor(Number(from.system?.currency?.[denomination]) || 0);
    if ( count > have ) throw new Error(t("error.notEnoughCoin", { qty: have, denomination }));
    fromUpdate[`system.currency.${denomination}`] = have - count;
    const theirs = Math.floor(Number(to.system?.currency?.[denomination]) || 0);
    toUpdate[`system.currency.${denomination}`] = theirs + count;
  }
  await journalPurse(from, journal, () => from.update(fromUpdate));
  await journalPurse(to, journal, () => to.update(toUpdate));
}

/** Add copper to an actor's purse, in the largest denominations that fit. */
async function credit(actor, cp) {
  const total = totalCp(actor.system?.currency) + cp;
  await actor.update({ "system.currency": spreadCopper(total) });
}

/**
 * Express a copper total as a gp/sp/cp purse.
 *
 * Used only when *writing back* a whole purse. Platinum and electrum are deliberately not
 * produced: a Trader paying out in platinum would quietly convert a party's small change into
 * coins the next shop may not break, and electrum is a unit nobody reckons in.
 */
function spreadCopper(cp) {
  const value = Math.max(0, Math.round(cp));
  return {
    pp: 0,
    gp: Math.floor(value / 100),
    ep: 0,
    sp: Math.floor((value % 100) / 10),
    cp: value % 10
  };
}

/**
 * Put the items a character bought into their pack.
 *
 * Created from the Trader's own item data rather than re-resolved from a compendium, so a GM's
 * edits to a stocked item — a renamed blade, a tweaked description — are what the player
 * actually receives. The data goes through `stock.mjs#transferData`, which clears equipped and
 * attuned: a Trader's copy should never have them, and a character must attune for themselves.
 */
async function grantBoughtItems(actor, buying, journal) {
  if ( !buying.length ) return [];
  const data = buying.map(line => {
    const source = transferData(line.item.toObject(), line.qty);
    // The shop's own per-line settings are the Trader's bookkeeping and mean nothing on a
    // character sheet; carrying them over would leave "restock to 3" on a player's new sword.
    source.flags = { ...source.flags };
    delete source.flags[MODULE_ID];
    return source;
  });
  return createItems(actor, data, journal, "granted");
}

/**
 * Add what a character sold onto the Trader's shelves.
 *
 * Merged into an existing line where the Trader already stocks the same thing, so selling three
 * daggers to a Trader that has two leaves one row of five rather than two rows. What arrives is
 * unequipped and unattuned — it was the character's state, not the item's.
 */
async function absorbSoldItems(trader, selling, journal) {
  const toCreate = [];
  const toUpdate = new Map();

  for ( const line of selling ) {
    const existing = trader.items.find(i => i.type === line.item.type && i.name === line.name);
    if ( existing && !stockLine(existing).unlimited ) {
      toUpdate.set(existing.id, (toUpdate.get(existing.id) ?? 0) + line.qty);
      continue;
    }
    if ( existing ) continue;      // unlimited: nothing to add to

    const source = transferData(line.item.toObject(), line.qty);
    // Bought-in stock starts with sane shop settings rather than inheriting whatever the
    // character's copy carried.
    source.flags = {
      ...source.flags,
      [MODULE_ID]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: line.qty }
    };
    toCreate.push(source);
  }

  if ( toUpdate.size ) {
    const changes = [...toUpdate].map(([id, qty]) => {
      const current = Number(trader.items.get(id)?.system?.quantity) || 0;
      return { id, qty: -qty, left: current + qty };
    });
    // Recorded as a negative take, so the reversal subtracts what the sale added.
    await takeQuantities(trader, changes, journal, "shelf");
  }
  await createItems(trader, toCreate, journal, "shelf");
}

/* -------------------------------------------- */
/*  The query                                   */
/* -------------------------------------------- */

/**
 * Settle a trade, end to end.
 *
 * Exported so the API and the harness can call it directly with the same guarantees the query
 * gives — there must be exactly one settlement path, or the tested one is not the shipped one.
 * @param {object} params
 * @param {object} params.trader
 * @param {object} params.actor
 * @param {object} params.intent
 * @returns {Promise<object>}  The receipt data.
 */
export function settle({ trader, actor, payer = actor, intent, user = game.user }) {
  // Queued, planning included: a plan made before an earlier settlement has finished writing is
  // a plan made against stale stock and stale purses. See `data/serial.mjs`.
  return serialised(() => settleNow({ trader, actor, payer, intent, user }));
}

/** The body of {@link settle}. Only ever run from inside the settlement queue. */
async function settleNow({ trader, actor, payer, intent, user }) {
  const plan = planTrade({ trader, actor, payer, intent });

  // The veto, fired *after* pricing and *before* any write, on the GM's client. A house-rule
  // module can refuse a trade the players have already confirmed — and because nothing has been
  // written yet, refusing leaves no trace.
  if ( !fireCancellableHook(HOOKS.preTrade, { trader, actor, payer, intent, priced: plan }) ) {
    fireHook(HOOKS.tradeRejected, { trader, actor, intent, reason: "vetoed" });
    throw new Error(t("error.tradeVetoed"));
  }

  const receipt = await applyWrites(plan);
  await postReceipt(receipt);
  await writeLedger(trader, receipt, user);
  fireHook(HOOKS.tradeCompleted, { trader, actor, receipt });
  log(`settled: ${receipt.bought.length} bought, ${receipt.sold.length} sold, `
    + `net ${formatCp(receipt.netCp)}`);
  return receipt;
}

/**
 * Record a settled trade in the Trader's ledger.
 *
 * Failures are swallowed, for the reason a receipt's are: the goods and the coin have already
 * moved, and a ledger that could not be written must not turn a successful trade into a refusal
 * the player then retries.
 * @param {object} trader
 * @param {object} receipt
 * @param {object} [user]  Who pressed the button; recorded by name.
 */
async function writeLedger(trader, receipt, user) {
  try {
    await recordTrade(trader, makeEntry({
      id: foundry.utils.randomID(),
      receipt,
      worldTime: game.time.worldTime,
      realTime: Date.now(),
      userName: user?.name ?? ""
    }));
  } catch ( err ) {
    log("recording a trade in the ledger failed; the trade itself stands", err);
  }
}

defineQuery(QUERIES.trade, async (data, { user }) => {
  const { trader, actor } = resolveParties(data, user);
  const payer = resolvePayer({ actor, payerId: data?.payerId }, user);
  try {
    const receipt = await settle({ trader, actor, payer, intent: data, user });
    // The document is not serialisable; the client only needs the figures and the new attitude.
    return {
      ok: true,
      costCp: receipt.costCp,
      creditCp: receipt.creditCp,
      netCp: receipt.netCp,
      attitudeGained: receipt.attitudeGained,
      attitudeNow: receipt.attitudeNow
    };
  } catch ( err ) {
    fireHook(HOOKS.tradeRejected, { trader, actor, intent: data, reason: err.message });
    throw err;
  }
}, { exclusive: true });
