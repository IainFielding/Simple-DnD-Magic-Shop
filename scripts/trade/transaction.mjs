import { HOOKS, MODULE_ID, fireCancellableHook, fireHook, log, t } from "../config.mjs";
import { attitudeTier } from "../data/attitude.mjs";
import {
  applyMultiplier, barterBalance, formatCp, resolveMultipliers, totalCp
} from "../data/pricing.mjs";
import { acceptsItem, availableQty, effectiveValueCp, lineVisible } from "../data/stock.mjs";
import {
  bookSpend, getAttitude, purse, recordTrade, stockLine, traderData
} from "../data/trader.mjs";
import { makeEntry } from "../data/ledger.mjs";
import { serialised } from "../data/serial.mjs";
import { postReceipt } from "./receipt.mjs";
import { QUERIES, defineQuery } from "./queries.mjs";
import { resolveParties, resolvePayer } from "./context.mjs";

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
 * set of writes, and only then applies them. The one place that cannot be made atomic is the
 * boundary between Foundry document updates themselves; {@link applyWrites} orders them so that
 * the failure that survives is the recoverable one (see its comment).
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

    buying.push({
      id: item.id,
      item,
      line,
      name: item.name,
      img: item.img,
      qty,
      unitCp: applyMultiplier(valueCp, multipliers.buy),
      valueCp,
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
    selling.push({
      id: item.id,
      item,
      name: item.name,
      img: item.img,
      qty,
      unitCp: applyMultiplier(valueCp, multipliers.sell),
      valueCp,
      held
    });
  }

  if ( !buying.length && !selling.length ) throw new Error(t("error.nothingStaged"));

  /* --- The money -------------------------------------------------------- */
  // `actorPurseCp` keeps its name for the plan's consumers, but it is the *paying* purse: with a
  // Group paying, what the character carries is beside the point.
  const actorPurseCp = totalCp(payer.system?.currency);
  const traderPurseCp = totalCp(purse(trader));

  const plan = {
    mode, trader, actor, payer, buying, selling, multipliers, attitude,
    actorPurseCp, traderPurseCp
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
    take: plan.buying.map(l => ({ id: l.id, valueCp: l.valueCp, qty: l.qty })),
    give: plan.selling.map(l => ({ id: l.id, valueCp: l.valueCp, qty: l.qty })),
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
 * Write a validated plan.
 *
 * ## Ordering
 *
 * Foundry has no transactions, so the order is chosen so the *survivable* failure is the one
 * that can happen:
 *
 *  1. **Coin first.** Currency is the only thing that can fail for a reason validation could
 *     miss (a concurrent purchase by the same character on another client), and it is the
 *     cheapest thing to have not happened.
 *  2. **Then the Trader's stock**, decremented or removed.
 *  3. **Then the character's items** — additions and removals together.
 *
 * If step 3 fails after step 2, the party is owed an item and the GM can see exactly what from
 * the receipt, which is not posted until everything has landed. The reverse order would risk
 * handing over goods for free, which is worse.
 *
 * @param {object} plan  From {@link planTrade}.
 * @returns {Promise<object>}  The receipt data.
 */
export async function applyWrites(plan) {
  const { trader, actor, payer = actor, buying, selling, mode } = plan;

  /* --- 1. Coin ---------------------------------------------------------- */
  await moveCoin(plan);

  /* --- 2. The Trader's shelves ------------------------------------------ */
  const stockUpdates = [];
  const stockDeletes = [];
  for ( const line of buying ) {
    // An unlimited line is the point of being unlimited: it never depletes.
    if ( line.unlimited ) continue;
    const left = line.available - line.qty;
    if ( left > 0 ) stockUpdates.push({ _id: line.id, "system.quantity": left });
    else stockDeletes.push(line.id);
  }
  if ( stockUpdates.length ) await trader.updateEmbeddedDocuments("Item", stockUpdates);
  if ( stockDeletes.length ) await trader.deleteEmbeddedDocuments("Item", stockDeletes);

  // What the character sold goes onto the Trader's shelves, because a shop that buys things has
  // them afterwards — and because it is what lets a party come back for the sword they regret.
  if ( selling.length ) await absorbSoldItems(trader, selling);

  /* --- 3. The character's pack ------------------------------------------ */
  const packUpdates = [];
  const packDeletes = [];
  for ( const line of selling ) {
    const left = line.held - line.qty;
    if ( left > 0 ) packUpdates.push({ _id: line.id, "system.quantity": left });
    else packDeletes.push(line.id);
  }
  if ( packUpdates.length ) await actor.updateEmbeddedDocuments("Item", packUpdates);
  if ( packDeletes.length ) await actor.deleteEmbeddedDocuments("Item", packDeletes);

  await grantBoughtItems(actor, buying);

  /* --- Goodwill --------------------------------------------------------- */
  // Only what the character actually *spent* counts. Selling into a Trader's purse is not
  // patronage, and crediting it would let a party farm goodwill by selling junk back and forth.
  // In a barter, `creditCp` is the whole offer — goods at their sell value *plus* the coin —
  // so it is counted once. This used to add `goldCp` on top, which counted every coin twice and
  // let a barter with coin earn goodwill faster than the same trade made in cash.
  const spentCp = mode === "barter" ? plan.creditCp : Math.max(0, plan.netCp);
  const gain = spentCp > 0
    ? await bookSpend(trader, actor, spentCp)
    : { points: 0, to: plan.attitude };

  return {
    mode,
    trader,
    actor,
    payer,
    // Built from the plan rather than from the created documents: the plan is what knows the
    // prices, and pairing two arrays by index would break the moment one of them was filtered.
    bought: buying.map(receiptLine),
    sold: selling.map(receiptLine),
    costCp: plan.costCp,
    creditCp: plan.creditCp,
    netCp: plan.netCp,
    attitudeGained: gain.points,
    attitudeNow: gain.to,
    attitudeTier: attitudeTier(gain.to).label
  };
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
    uuid: line.item?._stats?.compendiumSource || line.item?.uuid || ""
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
 */
async function moveCoin(plan) {
  const { trader, netCp, mode, goldCp, coins } = plan;
  const actor = plan.payer ?? plan.actor;
  const manager = globalThis.dnd5e?.applications?.CurrencyManager;

  // Named coins move as those coins: three platinum offered leave the purse as three platinum
  // and arrive in the Trader's as three platinum, with no change-making in either direction.
  if ( mode === "barter" && coins ) return moveNamedCoins(actor, trader, coins);

  // Barter moves only the coin the character chose to add.
  const fromActorCp = mode === "barter" ? goldCp : Math.max(0, netCp);
  const toActorCp = mode === "barter" ? 0 : Math.max(0, -netCp);

  if ( fromActorCp > 0 ) {
    await deduct(manager, actor, fromActorCp);
    await credit(trader, fromActorCp);
  }
  if ( toActorCp > 0 ) {
    await deduct(manager, trader, toActorCp);
    await credit(actor, toActorCp);
  }
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
async function moveNamedCoins(from, to, coins) {
  const fromUpdate = {};
  const toUpdate = {};
  for ( const [denomination, count] of Object.entries(coins) ) {
    const have = Math.floor(Number(from.system?.currency?.[denomination]) || 0);
    if ( count > have ) throw new Error(t("error.notEnoughCoin", { qty: have, denomination }));
    fromUpdate[`system.currency.${denomination}`] = have - count;
    const theirs = Math.floor(Number(to.system?.currency?.[denomination]) || 0);
    toUpdate[`system.currency.${denomination}`] = theirs + count;
  }
  await from.update(fromUpdate);
  await to.update(toUpdate);
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
 * actually receives.
 */
async function grantBoughtItems(actor, buying) {
  if ( !buying.length ) return [];
  const data = buying.map(line => {
    const source = line.item.toObject();
    delete source._id;
    source.system = { ...source.system, quantity: line.qty };
    // The shop's own per-line settings are the Trader's bookkeeping and mean nothing on a
    // character sheet; carrying them over would leave "restock to 3" on a player's new sword.
    source.flags = { ...source.flags };
    delete source.flags[MODULE_ID];
    return source;
  });
  return actor.createEmbeddedDocuments("Item", data);
}

/**
 * Add what a character sold onto the Trader's shelves.
 *
 * Merged into an existing line where the Trader already stocks the same thing, so selling three
 * daggers to a Trader that has two leaves one row of five rather than two rows.
 */
async function absorbSoldItems(trader, selling) {
  const toCreate = [];
  const toUpdate = new Map();

  for ( const line of selling ) {
    const existing = trader.items.find(i => i.type === line.item.type && i.name === line.name);
    if ( existing && !stockLine(existing).unlimited ) {
      const current = Number(existing.system?.quantity) || 0;
      toUpdate.set(existing.id, (toUpdate.get(existing.id) ?? current) + line.qty);
      continue;
    }
    if ( existing ) continue;      // unlimited: nothing to add to

    const source = line.item.toObject();
    delete source._id;
    source.system = { ...source.system, quantity: line.qty };
    // Bought-in stock starts with sane shop settings rather than inheriting whatever the
    // character's copy carried.
    source.flags = {
      ...source.flags,
      [MODULE_ID]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: line.qty }
    };
    toCreate.push(source);
  }

  if ( toUpdate.size ) {
    await trader.updateEmbeddedDocuments("Item", [...toUpdate].map(([id, qty]) => ({
      _id: id, "system.quantity": qty
    })));
  }
  if ( toCreate.length ) await trader.createEmbeddedDocuments("Item", toCreate);
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
});
