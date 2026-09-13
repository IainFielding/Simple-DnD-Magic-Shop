/**
 * The assertions that only a real world can answer, run inside Foundry's own page.
 *
 * Imports the module under test directly — Foundry serves this directory over HTTP because the
 * repo is junction-linked into `Data/modules` — so these are real ES modules calling real
 * functions against real documents, not strings of code pasted through `page.evaluate`.
 *
 * ## What belongs here rather than in vitest
 *
 * Only what needs a world. The maths is covered by 195 unit tests and repeating any of it here
 * would buy nothing and run a thousand times slower. What lives here is everything involving a
 * *document*, a *socket*, or a *second client*: the permission boundary, the authority of the
 * GM's re-derived prices, and the atomicity of a settlement.
 */

const MODULE = "sogrom-simple-dnd5e-magic-shop";
const BASE = `/modules/${MODULE}/scripts`;
const PREFIX = "[e2e]";

/* -------------------------------------------- */
/*  A very small test framework                 */
/* -------------------------------------------- */

/**
 * Results accumulate into a flat list and cross back to Node as JSON.
 *
 * Deliberately not a real test runner: everything here runs in a browser page whose only
 * channel to the outside is one serialisable return value, and every case has to report
 * independently so that one failure does not cascade into six.
 */
class Report {
  cases = [];

  /** Record a passing or failing assertion. */
  check(name, condition, detail = "") {
    this.cases.push({ name, pass: !!condition, detail: condition ? "" : String(detail) });
    return !!condition;
  }

  /** Record equality, putting both values in the detail so a failure explains itself. */
  equal(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(name, pass, pass ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  /** Record that a promise rejected, which for this module is how a refusal arrives. */
  async rejects(name, promise, matcher) {
    try {
      await promise;
      return this.check(name, false, "expected a refusal, but it resolved");
    } catch ( err ) {
      if ( matcher && !matcher.test(err.message) ) {
        return this.check(name, false, `refused, but with: ${err.message}`);
      }
      return this.check(name, true);
    }
  }

  /** Note something that went wrong outside any single assertion. */
  fail(name, err) {
    this.cases.push({ name, pass: false, detail: `${err?.message ?? err}\n${err?.stack ?? ""}` });
  }

  get summary() {
    const failed = this.cases.filter(c => !c.pass);
    return { total: this.cases.length, failed: failed.length, cases: this.cases };
  }
}

/* -------------------------------------------- */
/*  Fixtures                                    */
/* -------------------------------------------- */

/** Import the module's own code, so the harness tests what ships rather than a copy. */
async function load() {
  const [config, registry, trader, stock, pricing, context, queries] = await Promise.all([
    import(`${BASE}/config.mjs`),
    import(`${BASE}/data/registry.mjs`),
    import(`${BASE}/data/trader.mjs`),
    import(`${BASE}/data/stock.mjs`),
    import(`${BASE}/data/pricing.mjs`),
    import(`${BASE}/trade/context.mjs`),
    import(`${BASE}/trade/queries.mjs`)
  ]);
  return { config, registry, trader, stock, pricing, context, queries };
}

/**
 * Build a Trader with known stock, so assertions can name exact prices.
 *
 * Items are hand-built rather than pulled from a compendium: a test asserting "this costs 1,100
 * copper" needs an item whose value it chose, and must not break when a content pack is updated.
 * @returns {Promise<object>} The Trader actor.
 */
async function makeTrader(mod, { name = `${PREFIX} Test Trader`, gp = 500 } = {}) {
  const existing = game.actors.find(a => a.name === name);
  if ( existing ) await existing.delete();

  const actor = await mod.registry.createTrader({ name, greeting: "Wares!" });
  await actor.update({ "system.currency": { pp: 0, gp, ep: 0, sp: 0, cp: 0 } });

  await actor.createEmbeddedDocuments("Item", [
    {
      name: `${PREFIX} Common Blade`,
      type: "weapon",
      img: "icons/svg/sword.svg",
      system: { quantity: 3, price: { value: 10, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 3 } }
    },
    {
      name: `${PREFIX} Endless Rations`,
      type: "consumable",
      img: "icons/svg/item-bag.svg",
      system: { quantity: 1, price: { value: 5, denomination: "sp" } },
      flags: { [MODULE]: { unlimited: true, overrideCp: null, revealAt: null, baseQty: 1 } }
    },
    {
      // Gated: this is the line the hidden-stock assertions turn on.
      name: `${PREFIX} Secret Relic`,
      type: "loot",
      img: "icons/svg/mystery-man.svg",
      system: { quantity: 1, price: { value: 100, denomination: "gp" }, rarity: "veryRare" },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: 90, baseQty: 1 } }
    },
    {
      name: `${PREFIX} Last One`,
      type: "loot",
      img: "icons/svg/item-bag.svg",
      system: { quantity: 1, price: { value: 1, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 1 } }
    }
  ]);

  return actor;
}

/** The harness's two characters, by the names `in-world/provision.mjs` gave them. */
function characters() {
  return {
    vex: game.actors.find(a => a.name === `${PREFIX} Vex`),
    thog: game.actors.find(a => a.name === `${PREFIX} Thog`)
  };
}

/** The User who owns a character, for the authorisation assertions. */
function ownerOf(actor) {
  return game.users.find(u => u.character?.id === actor?.id);
}

/* -------------------------------------------- */
/*  Suite: the context payload                  */
/* -------------------------------------------- */

/**
 * What a player's browser is and is not told.
 *
 * The headline case is hidden stock: a gated line must be **absent from the payload**, not
 * present and hidden by CSS. Asserting on the payload rather than on the DOM is the only way to
 * know that, and it is the difference between a real access control and a cosmetic one.
 */
export async function contextSuite() {
  const report = new Report();
  const mod = await load();
  try {
    const trader = await makeTrader(mod);
    const { vex, thog } = characters();
    report.check("both harness characters exist", vex && thog, `vex=${!!vex} thog=${!!thog}`);
    if ( !vex || !thog ) return report.summary;

    const payload = mod.context.buildShopContext(trader, thog);

    report.check("the payload names the trader", payload.trader?.name === trader.name);
    report.check("the payload carries an attitude tier", !!payload.attitude?.key);
    report.equal("a stranger starts at the default attitude", payload.attitude.value, 50);

    const names = payload.stock.map(l => l.name);
    report.check("visible stock is listed", names.includes(`${PREFIX} Common Blade`), names.join(", "));
    report.check(
      "gated stock is ABSENT from the payload, not merely hidden",
      !names.some(n => n.includes("Secret Relic")),
      `payload stock was: ${names.join(", ")}`
    );
    report.check(
      "no reveal threshold crosses the wire at all",
      !JSON.stringify(payload).includes("revealAt"),
      "the payload mentioned revealAt"
    );

    // The same Trader, seen by a character it adores: the gated line appears.
    await mod.trader.setAttitude(trader, thog, 95);
    const favoured = mod.context.buildShopContext(trader, thog);
    report.check(
      "the gated line appears once the threshold is met",
      favoured.stock.some(l => l.name.includes("Secret Relic")),
      favoured.stock.map(l => l.name).join(", ")
    );
    await mod.trader.setAttitude(trader, thog, 50);

    // Charisma divergence — the pricing model's headline behaviour, on real actors.
    const forVex = mod.context.buildShopContext(trader, vex);
    const forThog = mod.context.buildShopContext(trader, thog);
    const blade = list => list.stock.find(l => l.name.includes("Common Blade"));
    report.check(
      "a charismatic character is quoted a lower price than a graceless one",
      blade(forVex).buyCp < blade(forThog).buyCp,
      `vex=${blade(forVex).buyCp} thog=${blade(forThog).buyCp}`
    );
    report.equal("the graceless price is the documented 1.10x", blade(forThog).buyCp, 1100);
    report.equal("the charismatic price is the documented 0.875x", blade(forVex).buyCp, 875);

    // An unlimited line must survive JSON, where Infinity does not.
    const rations = forThog.stock.find(l => l.name.includes("Endless Rations"));
    report.check("an unlimited line is flagged rather than sent as Infinity", rations?.unlimited === true);
    report.check("its quantity survives serialisation", Number.isFinite(rations?.qty));

    // The character's own gear, as the Trader values it.
    const pack = forThog.pack.map(l => l.name);
    report.check("sellable gear is offered", pack.some(n => n.includes("Plain Sword")), pack.join(", "));
    report.check(
      "an item with no value is not offered as sellable",
      !pack.some(n => n.includes("Worthless Rock")),
      pack.join(", ")
    );

    await trader.delete();
  } catch ( err ) {
    report.fail("contextSuite threw", err);
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  Suite: authorisation                        */
/* -------------------------------------------- */

/**
 * Who may shop as whom.
 *
 * The query framework hands the handler the *requesting* User, and this is what proves the
 * handler actually uses it. Without this check any player could shop out of another player's
 * purse by passing a different actor id — the single worst bug this module could have.
 */
export async function authoritySuite() {
  const report = new Report();
  const mod = await load();
  try {
    const trader = await makeTrader(mod);
    const { vex, thog } = characters();
    const vexUser = ownerOf(vex);
    const thogUser = ownerOf(thog);
    report.check("both characters have owning users", vexUser && thogUser);
    if ( !vexUser || !thogUser ) return report.summary;

    const resolve = (data, user) => mod.context.resolveParties(data, user);

    // The good case, so a failure below cannot be "nothing works".
    report.check("a player may shop as their own character", !!resolve(
      { traderId: trader.id, actorId: thog.id }, thogUser
    ).actor);

    // The case that matters.
    report.check(
      "a player may NOT shop as someone else's character",
      (() => {
        try {
          resolve({ traderId: trader.id, actorId: vex.id }, thogUser);
          return false;
        } catch {
          return true;
        }
      })(),
      "a player was allowed to use another player's character"
    );

    report.check("a GM may shop as anyone", !!resolve(
      { traderId: trader.id, actorId: vex.id }, game.user
    ).actor);

    // An id that is not a Trader must not become one by being asked for.
    report.check(
      "a plain actor cannot be used as a trader",
      (() => {
        try {
          resolve({ traderId: thog.id, actorId: thog.id }, game.user);
          return false;
        } catch {
          return true;
        }
      })()
    );

    // The query must be registered, or every player's shop silently fails.
    report.check(
      "the shop-context query is registered",
      typeof CONFIG.queries?.[mod.queries.QUERIES.context] === "function",
      Object.keys(CONFIG.queries ?? {}).join(", ")
    );
    report.check(
      "a GM counts as available to answer",
      mod.queries.gmAvailable() === true
    );

    await trader.delete();
  } catch ( err ) {
    report.fail("authoritySuite threw", err);
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  Suite: the trader lifecycle                 */
/* -------------------------------------------- */

/** Creating, stocking, duplicating and deleting a Trader against real documents. */
export async function traderSuite() {
  const report = new Report();
  const mod = await load();
  try {
    const before = mod.registry.listTraders().length;
    const trader = await makeTrader(mod, { name: `${PREFIX} Lifecycle` });

    report.check("a new Trader is flagged as one", mod.trader.isTrader(trader));
    report.check("it joins the registry", mod.registry.listTraders().length === before + 1);
    report.check("it lands in the module's folder", !!trader.folder);
    report.equal("its stock is its embedded items", trader.items.size, 4);

    // The flag layout the whole data layer depends on.
    const line = mod.trader.stockLine(trader.items.find(i => i.name.includes("Endless")));
    report.check("per-line settings round-trip through the item flag", line.unlimited === true);

    // Duplication must not carry opinions across: "the same shop in the next town" has never
    // met the party.
    const { thog } = characters();
    await mod.trader.setAttitude(trader, thog, 88);
    const copy = await mod.registry.duplicateTrader(trader.id);
    report.check("a duplicate keeps the stock", copy.items.size === trader.items.size);
    report.equal(
      "a duplicate has no opinion of anyone yet",
      mod.trader.getAttitude(copy, thog),
      50
    );

    // Adding the same item twice raises the line rather than making a second row.
    const source = trader.items.find(i => i.name.includes("Common Blade"));
    const rowsBefore = copy.items.size;
    await mod.trader.addStockItems(copy, [source.uuid]);
    report.check(
      "adding a duplicate item does not add a second row",
      copy.items.size === rowsBefore,
      `rows went ${rowsBefore} -> ${copy.items.size}: `
        + copy.items.map(i => i.name).join(", ")
    );

    await mod.registry.deleteTrader(copy.id);
    await mod.registry.deleteTrader(trader.id);
    report.check("deleting removes it from the registry",
      mod.registry.listTraders().length === before);
  } catch ( err ) {
    report.fail("traderSuite threw", err);
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  Suite: attitude, against documents          */
/* -------------------------------------------- */

/** Attitude persistence, the hook contract, and the spend-driven drift. */
export async function attitudeSuite() {
  const report = new Report();
  const mod = await load();
  try {
    const trader = await makeTrader(mod, { name: `${PREFIX} Attitude` });
    const { thog } = characters();

    report.equal("an unmet character gets the Trader's own default",
      mod.trader.getAttitude(trader, thog), 50);

    const fired = [];
    const hookId = Hooks.on(`simpleMagicShop.attitudeChanged`, payload => fired.push(payload));

    const moved = await mod.trader.setAttitude(trader, thog, 70);
    report.equal("setting reports the move", { from: moved.from, to: moved.to, changed: moved.changed },
      { from: 50, to: 70, changed: true });
    report.equal("it persists", mod.trader.getAttitude(trader, thog), 70);
    report.equal("attitudeChanged fired exactly once", fired.length, 1);

    // A no-op must not write or fire: an adored party would otherwise generate a document write
    // and a hook on every single purchase, forever.
    const again = await mod.trader.setAttitude(trader, thog, 70);
    report.check("re-setting the same value changes nothing", again.changed === false);
    report.equal("and fires nothing", fired.length, 1);

    Hooks.off(`simpleMagicShop.attitudeChanged`, hookId);

    // The veto contract.
    const vetoId = Hooks.on(`simpleMagicShop.preAttitudeChange`, () => false);
    const vetoed = await mod.trader.setAttitude(trader, thog, 20);
    report.check("a preAttitudeChange veto is honoured", vetoed.vetoed === true);
    report.equal("and the stored value is untouched", mod.trader.getAttitude(trader, thog), 70);
    Hooks.off(`simpleMagicShop.preAttitudeChange`, vetoId);

    // The spend drift, through the real document path.
    await mod.trader.setAttitude(trader, thog, 50);
    const gain = await mod.trader.bookSpend(trader, thog, 30_000);   // 300 gp
    report.equal("spending 300 gp earns three points at the default rate", gain.points, 3);
    report.equal("and lands on the actor", mod.trader.getAttitude(trader, thog), 53);

    const capped = await mod.trader.bookSpend(trader, thog, 10_000_000);
    report.check("the per-visit cap holds", capped.points <= 5, `earned ${capped.points}`);

    const spend = mod.trader.spendFor(trader, thog);
    report.check("the spend record accumulates", spend.lifetimeCp > 30_000, JSON.stringify(spend));

    await mod.registry.deleteTrader(trader.id);
  } catch ( err ) {
    report.fail("attitudeSuite threw", err);
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  Suite: the chat card                        */
/* -------------------------------------------- */

/** Posting a card, and that its button carries what the click handler needs. */
export async function cardSuite() {
  const report = new Report();
  const mod = await load();
  try {
    const card = await import(`${BASE}/app/chat-card.mjs`);
    const trader = await makeTrader(mod, { name: `${PREFIX} Card` });

    const message = await card.postTraderCard(trader.id);
    report.check("a card is posted", !!message);
    report.check("it is flagged as ours", message.getFlag(MODULE, "traderId") === trader.id);
    report.check("its button carries the trader id",
      message.content.includes(`data-shop-trader="${trader.id}"`),
      message.content.slice(0, 300));
    report.check("the greeting is rendered", message.content.includes("Wares!"),
      `card content: ${message.content.replace(/\s+/g, " ").slice(0, 200)}`);

    await message.delete();
    await mod.registry.deleteTrader(trader.id);
  } catch ( err ) {
    report.fail("cardSuite threw", err);
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  Suite: stock from a roll table              */
/* -------------------------------------------- */

/**
 * Drawing stock from a RollTable: the number of draws is honoured, and the GM's table is not
 * used up by it.
 */
export async function rollTableSuite() {
  const report = new Report();
  const mod = await load();
  const generate = await import(`${BASE}/data/generate.mjs`);
  let trader = null;
  let table = null;
  let gems = [];
  try {
    gems = await Item.createDocuments(["A", "B", "C"].map(letter => ({
      name: `${PREFIX} Table Gem ${letter}`,
      type: "loot",
      system: { quantity: 1, price: { value: 10, denomination: "gp" } }
    })));
    table = await RollTable.create({
      name: `${PREFIX} Gem Table`,
      formula: "1d3",
      replacement: false,
      results: gems.map((gem, i) => ({
        type: "document", documentUuid: gem.uuid, name: gem.name, weight: 1, range: [i + 1, i + 1]
      }))
    });
    const messagesBefore = game.messages.size;

    const uuids = await generate.rollTableStock(table, 3);
    report.equal("asking for three draws rolls three times", uuids.length, 3);
    report.check("and every result is one of the table's items",
      uuids.every(uuid => gems.some(gem => gem.uuid === uuid)), uuids.join(", "));
    report.check("and the table is left as it was, nothing marked drawn",
      table.results.every(result => !result.drawn),
      `${table.results.filter(r => r.drawn).length} result(s) marked drawn`);
    report.equal("and no roll cards were posted", game.messages.size, messagesBefore);

    trader = await makeTrader(mod, { name: `${PREFIX} Table Stock` });
    const before = trader.items.size;
    await mod.trader.addStockItems(trader, uuids);
    const added = trader.items.filter(i => i.name.includes("Table Gem"));
    report.equal("the draws land on the shelf, a repeat raising its line",
      added.reduce((sum, item) => sum + item.system.quantity, 0), 3);
    report.check("with one row per distinct gem",
      trader.items.size - before === new Set(uuids).size,
      `rows went ${before} -> ${trader.items.size}`);
  } catch ( err ) {
    report.fail("rollTableSuite threw", err);
  } finally {
    if ( trader ) await mod.registry.deleteTrader(trader.id).catch(() => {});
    if ( table ) await table.delete().catch(() => {});
    for ( const gem of gems ) await gem.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/** Run every suite and merge the reports. */
export async function all() {
  const suites = {
    context: contextSuite,
    authority: authoritySuite,
    trader: traderSuite,
    attitude: attitudeSuite,
    card: cardSuite,
    rollTable: rollTableSuite
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
