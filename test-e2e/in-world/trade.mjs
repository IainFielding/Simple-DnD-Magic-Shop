/**
 * Settlement, against real documents.
 *
 * This is the file that matters most. The unit tests prove the arithmetic; these prove that the
 * arithmetic is what actually gets written — that coin leaves one purse and arrives in another,
 * that a shelf goes down by exactly what was taken, that a forged intent is refused, and that a
 * vetoed trade leaves **nothing** behind.
 *
 * Every case sets up its own Trader and tears it down, so one failure cannot cascade.
 */

const MODULE = "sogrom-simple-dnd5e-magic-shop";
const BASE = `/modules/${MODULE}/scripts`;
const PREFIX = "[e2e]";

/** Mirrors `harness.mjs`'s reporter; kept local so this file can be run on its own. */
class Report {
  cases = [];

  check(name, condition, detail = "") {
    this.cases.push({ name, pass: !!condition, detail: condition ? "" : String(detail) });
    return !!condition;
  }

  equal(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(name, pass, pass
      ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  async rejects(name, fn, matcher) {
    try {
      await fn();
      return this.check(name, false, "expected a refusal, but it went through");
    } catch ( err ) {
      if ( matcher && !matcher.test(err.message) ) {
        return this.check(name, false, `refused, but with: ${err.message}`);
      }
      return this.check(name, true);
    }
  }

  fail(name, err) {
    this.cases.push({ name, pass: false, detail: `${err?.message ?? err}\n${err?.stack ?? ""}` });
  }

  get summary() {
    return { total: this.cases.length, failed: this.cases.filter(c => !c.pass).length, cases: this.cases };
  }
}

async function load() {
  const [registry, trader, pricing, transaction] = await Promise.all([
    import(`${BASE}/data/registry.mjs`),
    import(`${BASE}/data/trader.mjs`),
    import(`${BASE}/data/pricing.mjs`),
    import(`${BASE}/trade/transaction.mjs`)
  ]);
  return { registry, trader, pricing, transaction };
}

/** A Trader with exactly known stock and purse. */
async function freshTrader(mod, { gp = 500, name = `${PREFIX} Till` } = {}) {
  const existing = game.actors.find(a => a.name === name);
  if ( existing ) await existing.delete();

  const actor = await mod.registry.createTrader({ name });
  await actor.update({ "system.currency": { pp: 0, gp, ep: 0, sp: 0, cp: 0 } });
  await actor.createEmbeddedDocuments("Item", [
    {
      name: `${PREFIX} Blade`,
      type: "weapon",
      system: { quantity: 3, price: { value: 10, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 3 } }
    },
    {
      name: `${PREFIX} Ration`,
      type: "consumable",
      system: { quantity: 1, price: { value: 5, denomination: "sp" } },
      flags: { [MODULE]: { unlimited: true, overrideCp: null, revealAt: null, baseQty: 1 } }
    },
    {
      name: `${PREFIX} Gated`,
      type: "loot",
      system: { quantity: 1, price: { value: 50, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: 95, baseQty: 1 } }
    }
  ]);
  return actor;
}

/** A shopper with a known purse and known sellable gear. */
async function freshShopper(name = `${PREFIX} Buyer`, { cha = 10, gp = 100 } = {}) {
  const existing = game.actors.find(a => a.name === name);
  if ( existing ) await existing.delete();

  const actor = await Actor.create({
    name,
    type: "character",
    system: {
      abilities: { cha: { value: cha } },
      currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 }
    }
  });
  await actor.createEmbeddedDocuments("Item", [
    {
      name: `${PREFIX} Old Dagger`,
      type: "weapon",
      system: { quantity: 2, price: { value: 20, denomination: "gp" } }
    }
  ]);
  return actor;
}

const cpOf = (mod, actor) => mod.pricing.totalCp(actor.system.currency);
const stockOf = (trader, name) => trader.items.find(i => i.name.includes(name));

/* -------------------------------------------- */

/** Buying: coin out, goods in, shelf down. */
export async function buySuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    trader = await freshTrader(mod);
    buyer = await freshShopper();

    const purseBefore = cpOf(mod, buyer);
    const tillBefore = cpOf(mod, trader);
    const blade = stockOf(trader, "Blade");

    const receipt = await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: blade.id, qty: 2 }], sell: [], goldCp: 0 }
    });

    // 10 gp at the documented 1.10x for a Charisma 10 stranger = 1100 cp each.
    report.equal("the price charged is the derived one", receipt.costCp, 2200);
    report.equal("the buyer's purse falls by exactly that", cpOf(mod, buyer), purseBefore - 2200);
    report.equal("the trader's purse rises by exactly that", cpOf(mod, trader), tillBefore + 2200);
    report.equal("the shelf falls by what was taken",
      stockOf(trader, "Blade").system.quantity, 1);

    const got = buyer.items.find(i => i.name.includes("Blade"));
    report.check("the buyer receives the item", !!got);
    report.equal("with the quantity they bought", got?.system?.quantity, 2);
    report.check("and without the shop's bookkeeping flags on it",
      !got?.flags?.[MODULE], JSON.stringify(got?.flags ?? {}));

    // An unlimited line is the point of being unlimited.
    const ration = stockOf(trader, "Ration");
    await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: ration.id, qty: 20 }], sell: [], goldCp: 0 }
    });
    report.equal("an unlimited line does not deplete",
      stockOf(trader, "Ration").system.quantity, 1);

    // Buying the last of a line removes the row rather than leaving a zero.
    const last = stockOf(trader, "Blade");
    await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: last.id, qty: 1 }], sell: [], goldCp: 0 }
    });
    report.check("buying the last one removes the line", !stockOf(trader, "Blade"));
  } catch ( err ) {
    report.fail("buySuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/** Selling, and netting a sale against a purchase in one settlement. */
export async function sellSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let seller;
  try {
    trader = await freshTrader(mod);
    seller = await freshShopper(`${PREFIX} Seller`);

    const purseBefore = cpOf(mod, seller);
    const dagger = seller.items.find(i => i.name.includes("Old Dagger"));

    const receipt = await mod.transaction.settle({
      trader, actor: seller,
      intent: { mode: "trade", buy: [], sell: [{ id: dagger.id, qty: 1 }], goldCp: 0 }
    });

    // 20 gp at the documented 0.45x sell multiplier = 900 cp.
    report.equal("the sale pays the derived amount", receipt.creditCp, 900);
    report.equal("the seller's purse rises by it", cpOf(mod, seller), purseBefore + 900);
    report.equal("their stack falls by one",
      seller.items.find(i => i.name.includes("Old Dagger"))?.system?.quantity, 1);
    report.check("and the trader now stocks it",
      !!stockOf(trader, "Old Dagger"), trader.items.map(i => i.name).join(", "));

    // The headline case: a sale funding a purchase in the same breath.
    const poor = await freshShopper(`${PREFIX} Pauper`, { gp: 1 });
    const blade = stockOf(trader, "Blade");
    const theirDagger = poor.items.find(i => i.name.includes("Old Dagger"));

    const netted = await mod.transaction.settle({
      trader, actor: poor,
      intent: {
        mode: "trade",
        buy: [{ id: blade.id, qty: 1 }],
        sell: [{ id: theirDagger.id, qty: 2 }],
        goldCp: 0
      }
    });
    // Buying 1100, selling 2 x 900 = 1800, so the shop owes 700.
    report.equal("a sale can fund a purchase in one settlement", netted.netCp, -700);
    report.equal("and the character ends up richer", cpOf(mod, poor), 100 + 700);
    await poor.delete();
  } catch ( err ) {
    report.fail("sellSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( seller ) await seller.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/** Every way a trade must be refused, and the proof that a refusal writes nothing. */
export async function refusalSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    trader = await freshTrader(mod, { gp: 5 });
    buyer = await freshShopper(`${PREFIX} Broke`, { gp: 1 });
    const blade = stockOf(trader, "Blade");
    const gated = stockOf(trader, "Gated");
    const dagger = buyer.items.find(i => i.name.includes("Old Dagger"));

    const settle = intent => () => mod.transaction.settle({ trader, actor: buyer, intent });

    await report.rejects("a purchase beyond the purse is refused",
      settle({ mode: "trade", buy: [{ id: blade.id, qty: 3 }], sell: [], goldCp: 0 }),
      /short/i);

    await report.rejects("taking more than the shelf holds is refused",
      settle({ mode: "trade", buy: [{ id: blade.id, qty: 99 }], sell: [], goldCp: 0 }),
      /only have/i);

    // The important one: a gated line the character cannot see must not be buyable even when
    // its id is named directly. The client greys it out; this proves the server refuses it.
    await report.rejects("a reveal-gated line cannot be bought by naming its id",
      settle({ mode: "trade", buy: [{ id: gated.id, qty: 1 }], sell: [], goldCp: 0 }),
      /any more|not for sale/i);

    await report.rejects("an item id that is not the trader's is refused",
      settle({ mode: "trade", buy: [{ id: dagger.id, qty: 1 }], sell: [], goldCp: 0 }),
      /any more/i);

    await report.rejects("an empty intent is refused",
      settle({ mode: "trade", buy: [], sell: [], goldCp: 0 }),
      /nothing/i);

    // A trader with 5 gp cannot buy a 20 gp dagger pair for 1800 cp.
    await report.rejects("a trader that cannot pay refuses the sale",
      settle({ mode: "trade", buy: [], sell: [{ id: dagger.id, qty: 2 }], goldCp: 0 }),
      /to pay with/i);

    // And after all of that, nothing moved.
    report.equal("after six refusals the buyer's purse is untouched", cpOf(mod, buyer), 100);
    report.equal("the trader's purse is untouched", cpOf(mod, trader), 500);
    report.equal("the shelf is untouched", stockOf(trader, "Blade").system.quantity, 3);
    report.equal("the buyer's gear is untouched",
      buyer.items.find(i => i.name.includes("Old Dagger"))?.system?.quantity, 2);
  } catch ( err ) {
    report.fail("refusalSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/**
 * The veto contract.
 *
 * A `preTrade` listener returning false must leave **no partial writes**. A veto that took the
 * coin and withheld the goods would be worse than no veto at all.
 */
export async function vetoSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer; let hookId = null;
  try {
    trader = await freshTrader(mod);
    buyer = await freshShopper(`${PREFIX} Vetoed`);
    const blade = stockOf(trader, "Blade");

    const purseBefore = cpOf(mod, buyer);
    const tillBefore = cpOf(mod, trader);

    const rejected = [];
    const rejectId = Hooks.on("simpleMagicShop.tradeRejected", p => rejected.push(p));
    hookId = Hooks.on("simpleMagicShop.preTrade", () => false);

    await report.rejects("a preTrade veto refuses the trade",
      () => mod.transaction.settle({
        trader, actor: buyer,
        intent: { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [], goldCp: 0 }
      }));

    report.equal("the veto leaves the buyer's purse untouched", cpOf(mod, buyer), purseBefore);
    report.equal("and the trader's purse untouched", cpOf(mod, trader), tillBefore);
    report.equal("and the shelf untouched", stockOf(trader, "Blade").system.quantity, 3);
    report.check("and hands the buyer nothing",
      !buyer.items.find(i => i.name.includes("Blade")));
    report.check("and announces the refusal", rejected.length === 1,
      `tradeRejected fired ${rejected.length} times`);

    Hooks.off("simpleMagicShop.preTrade", hookId);
    hookId = null;
    Hooks.off("simpleMagicShop.tradeRejected", rejectId);

    // With the veto lifted, the same trade goes through — so the failure above was the veto and
    // not something else broken.
    await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [], goldCp: 0 }
    });
    report.equal("lifting the veto lets the same trade through", cpOf(mod, buyer), purseBefore - 1100);
  } catch ( err ) {
    report.fail("vetoSuite threw", err);
  } finally {
    if ( hookId !== null ) Hooks.off("simpleMagicShop.preTrade", hookId);
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/** `prePrice`: the documented way to override pricing without forking the module. */
export async function prePriceSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer; let hookId = null;
  try {
    trader = await freshTrader(mod);
    buyer = await freshShopper(`${PREFIX} Discounted`);
    const blade = stockOf(trader, "Blade");

    // Half price, as a guild discount module would do it.
    hookId = Hooks.on("simpleMagicShop.prePrice", ({ multipliers }) => {
      multipliers.buy = 0.5;
    });

    const receipt = await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [], goldCp: 0 }
    });
    report.equal("a prePrice listener's multiplier is honoured", receipt.costCp, 500);
    Hooks.off("simpleMagicShop.prePrice", hookId);
    hookId = null;

    // A listener that sets nonsense must be ignored rather than handing out free items.
    hookId = Hooks.on("simpleMagicShop.prePrice", ({ multipliers }) => {
      multipliers.buy = -5;
    });
    const sane = await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: stockOf(trader, "Blade").id, qty: 1 }], sell: [], goldCp: 0 }
    });
    report.equal("an unusable multiplier falls back to the real price", sane.costCp, 1100);
  } catch ( err ) {
    report.fail("prePriceSuite threw", err);
  } finally {
    if ( hookId !== null ) Hooks.off("simpleMagicShop.prePrice", hookId);
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/** Barter: goods against goods, at the same rates a cash trade would use. */
export async function barterSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    trader = await freshTrader(mod);
    buyer = await freshShopper(`${PREFIX} Barterer`);
    const blade = stockOf(trader, "Blade");
    const dagger = buyer.items.find(i => i.name.includes("Old Dagger"));

    // Asking 1100 for the blade; one dagger offers 900. Short, so refused.
    await report.rejects("a barter that does not cover the ask is refused",
      () => mod.transaction.settle({
        trader, actor: buyer,
        intent: {
          mode: "barter",
          buy: [{ id: blade.id, qty: 1 }],
          sell: [{ id: dagger.id, qty: 1 }],
          goldCp: 0
        }
      }), /short/i);

    report.equal("and nothing moved", buyer.items.find(i => i.name.includes("Old Dagger"))
      ?.system?.quantity, 2);

    // Two daggers offer 1800 against 1100: accepted.
    const purseBefore = cpOf(mod, buyer);
    await mod.transaction.settle({
      trader, actor: buyer,
      intent: {
        mode: "barter",
        buy: [{ id: blade.id, qty: 1 }],
        sell: [{ id: dagger.id, qty: 2 }],
        goldCp: 0
      }
    });
    report.check("a sufficient barter goes through",
      !!buyer.items.find(i => i.name.includes("Blade")));
    report.check("the daggers are gone",
      !buyer.items.find(i => i.name.includes("Old Dagger")));
    report.equal("and no coin changed hands on an even-or-better swap",
      cpOf(mod, buyer), purseBefore);

    // Coin may top up an offer.
    const topUp = await freshShopper(`${PREFIX} TopUp`, { gp: 20 });
    const theirDagger = topUp.items.find(i => i.name.includes("Old Dagger"));
    const before = cpOf(mod, topUp);
    await mod.transaction.settle({
      trader, actor: topUp,
      intent: {
        mode: "barter",
        buy: [{ id: stockOf(trader, "Blade").id, qty: 1 }],
        sell: [{ id: theirDagger.id, qty: 1 }],
        goldCp: 300
      }
    });
    report.equal("staged coin leaves the purse", cpOf(mod, topUp), before - 300);
    await topUp.delete();

    // Named coins move as those coins. One platinum offered must leave the purse as one platinum
    // and arrive in the Trader's as one platinum — not be broken into gold, and not take the
    // character's silver instead.
    const coiner = await freshShopper(`${PREFIX} Coiner`, { gp: 0 });
    await coiner.update({ "system.currency": { pp: 1, gp: 0, ep: 0, sp: 9, cp: 0 } });
    const coinerDagger = coiner.items.find(i => i.name.includes("Old Dagger"));
    const traderPpBefore = Number(trader.system.currency.pp) || 0;

    await report.rejects("offering more of a coin than the purse holds is refused",
      () => mod.transaction.settle({
        trader, actor: coiner,
        intent: {
          mode: "barter",
          buy: [{ id: stockOf(trader, "Blade").id, qty: 1 }],
          sell: [{ id: coinerDagger.id, qty: 1 }],
          coins: { pp: 5 }
        }
      }), /only have/i);
    report.equal("and nothing left the purse", coiner.system.currency.pp, 1);

    await mod.transaction.settle({
      trader, actor: coiner,
      intent: {
        mode: "barter",
        buy: [{ id: stockOf(trader, "Blade").id, qty: 1 }],
        sell: [{ id: coinerDagger.id, qty: 1 }],
        // A tampered total alongside the coins must be ignored, not trusted.
        goldCp: 1,
        coins: { pp: 1 }
      }
    });
    report.equal("the offered platinum leaves the purse as platinum", coiner.system.currency.pp, 0);
    report.equal("the silver is untouched", coiner.system.currency.sp, 9);
    report.equal("no change is made into gold", coiner.system.currency.gp, 0);
    report.equal("and the Trader receives it as platinum",
      Number(trader.system.currency.pp) || 0, traderPpBefore + 1);
    await coiner.delete();
  } catch ( err ) {
    report.fail("barterSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/**
 * Change-making, which is the reason to use the system's own currency manager rather than
 * reimplementing coins.
 */
export async function currencySuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    trader = await freshTrader(mod);
    // A purse with no copper and no gold: paying 5 sp 5 cp requires breaking a platinum piece.
    buyer = await freshShopper(`${PREFIX} Platinum`, { gp: 0 });
    await buyer.update({ "system.currency": { pp: 5, gp: 0, ep: 0, sp: 0, cp: 0 } });

    const before = cpOf(mod, buyer);
    report.equal("the purse is worth 5000 cp in platinum alone", before, 5000);

    const ration = stockOf(trader, "Ration");   // 5 sp -> 55 cp at 1.10x
    const receipt = await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: ration.id, qty: 1 }], sell: [], goldCp: 0 }
    });

    report.equal("an odd price is charged exactly", receipt.costCp, 55);
    report.equal("and paid out of platinum by making change", cpOf(mod, buyer), before - 55);
    report.check("leaving real coins rather than a negative balance",
      Object.values(buyer.system.currency).every(v => v >= 0),
      JSON.stringify(buyer.system.currency));
  } catch ( err ) {
    report.fail("currencySuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/**
 * Two settlements racing for the last item on a shelf.
 *
 * Driven from one client because both settle on the GM's client anyway — the race that matters
 * is between two settlements, not two browsers. Exactly one must win, and the shelf must never
 * go negative.
 */
export async function raceSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let a; let b;
  try {
    trader = await freshTrader(mod);
    a = await freshShopper(`${PREFIX} Racer A`);
    b = await freshShopper(`${PREFIX} Racer B`);

    // One left, two buyers.
    const blade = stockOf(trader, "Blade");
    await blade.update({ "system.quantity": 1 });

    const intent = { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [], goldCp: 0 };
    const results = await Promise.allSettled([
      mod.transaction.settle({ trader, actor: a, intent }),
      mod.transaction.settle({ trader, actor: b, intent })
    ]);

    const won = results.filter(r => r.status === "fulfilled").length;
    report.equal("exactly one of two racers gets the last item", won, 1);

    const left = stockOf(trader, "Blade");
    report.check("the shelf never goes negative",
      !left || left.system.quantity >= 0,
      `quantity=${left?.system?.quantity}`);

    const holders = [a, b].filter(actor => actor.items.find(i => i.name.includes("Blade")));
    report.equal("and only one character is holding it", holders.length, 1);

    // The loser must not have paid. Both settlements can pass validation before either writes,
    // and coin moves before stock — so without serialisation the loser is charged, then its
    // stock write fails, and it walks away with nothing.
    const loser = [a, b].find(actor => !actor.items.find(i => i.name.includes("Blade")));
    if ( loser ) {
      report.equal("and the character who lost the race was not charged", cpOf(mod, loser), 10_000);
    }
    report.equal("and the Trader was paid exactly once", cpOf(mod, trader), 50_000 + 1100);
  } catch ( err ) {
    report.fail("raceSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( a ) await a.delete().catch(() => {});
    if ( b ) await b.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/** Run every settlement suite. */
export async function all() {
  const suites = {
    buy: buySuite,
    sell: sellSuite,
    refusal: refusalSuite,
    veto: vetoSuite,
    prePrice: prePriceSuite,
    barter: barterSuite,
    currency: currencySuite,
    race: raceSuite
  };
  const out = {};
  for ( const [name, fn] of Object.entries(suites) ) {
    try {
      out[name] = await fn();
    } catch ( err ) {
      out[name] = { total: 1, failed: 1, cases: [{ name, pass: false, detail: String(err) }] };
    }
  }
  return out;
}
