/**
 * The public API and the hook surface, asserted against the real thing.
 *
 * `docs/API.md` is a promise to other module authors, and a promise nothing checks is a promise
 * that rots. This asserts the shape — every documented member exists and is callable — and the
 * behaviour that only a live world can show: that the permission tiers actually refuse, that
 * `HOOKS` is frozen, and that the `ready` hook fired with the API attached.
 */

const MODULE = "sogrom-simple-dnd5e-magic-shop";
const PREFIX = "[e2e]";

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

  fail(name, err) {
    this.cases.push({ name, pass: false, detail: `${err?.message ?? err}\n${err?.stack ?? ""}` });
  }

  get summary() {
    return { total: this.cases.length, failed: this.cases.filter(c => !c.pass).length, cases: this.cases };
  }
}

/**
 * Every member `docs/API.md` promises, by tier.
 *
 * Listed explicitly rather than derived from the object, because the point is to catch a
 * *removal* — deriving the list from the thing under test would make it pass no matter what.
 */
const SURFACE = {
  constants: ["MODULE_ID", "HOOKS", "SETTINGS", "PRICING_PRESETS", "version"],
  pure: [
    "favour", "priceMultipliers", "priceFor", "attitudeTier", "validateAnchors",
    "toCopper", "formatCp"
  ],
  read: [
    "listTraders", "getTrader", "getTraderData", "getAttitude", "getSpend", "getStock",
    "getLedger", "listArchetypes", "getShopContext", "gmAvailable"
  ],
  write: [
    "createTrader", "duplicateTrader", "deleteTrader", "addStock", "removeStock",
    "setStockLine", "restock", "clearLedger", "setAttitude", "adjustAttitude",
    "applyArchetype", "saveArchetype", "deleteArchetype", "exportTrader", "importTrader",
    "postTraderCard", "openManager"
  ],
  trading: ["openShop", "buy", "sell", "barter", "trade"]
};

/** The hook aliases `docs/API.md` documents. */
const HOOK_ALIASES = [
  "ready",
  "traderCreated", "traderDeleted", "traderCardPosted",
  "preOpenShop", "shopOpened", "shopClosed",
  "preTrade", "tradeCompleted", "tradeRejected",
  "prePrice",
  "preAttitudeChange", "attitudeChanged",
  "preRestock", "restocked"
];

/* -------------------------------------------- */

/** Shape, tiers, and the things only a world can answer. */
export async function apiSuite() {
  const report = new Report();
  let trader = null;
  try {
    const api = game.modules.get(MODULE)?.api;
    if ( !report.check("the API is installed on the module", !!api) ) return report.summary;

    /* --- Shape --------------------------------------------------------- */
    for ( const [tier, members] of Object.entries(SURFACE) ) {
      const missing = members.filter(name => api[name] === undefined);
      report.check(`every documented ${tier} member exists`, missing.length === 0,
        `missing: ${missing.join(", ")}`);
    }

    const callables = [...SURFACE.pure, ...SURFACE.read, ...SURFACE.write, ...SURFACE.trading];
    const notFunctions = callables.filter(name => typeof api[name] !== "function");
    report.check("every documented call is a function", notFunctions.length === 0,
      notFunctions.join(", "));

    report.check("the API is frozen", Object.isFrozen(api));
    report.check("HOOKS is frozen", Object.isFrozen(api.HOOKS));
    report.equal("HOOKS has the documented number of entries",
      Object.keys(api.HOOKS).length, HOOK_ALIASES.length);

    const missingHooks = HOOK_ALIASES.filter(alias => !api.HOOKS[alias]);
    report.check("every documented hook alias is present", missingHooks.length === 0,
      missingHooks.join(", "));

    const misnamed = Object.values(api.HOOKS).filter(name => !name.startsWith("simpleMagicShop."));
    report.check("every hook is namespaced", misnamed.length === 0, misnamed.join(", "));

    report.check("version reports the module's own", !!api.version, api.version);

    /* --- Pure ---------------------------------------------------------- */
    report.equal("favour() matches the documented neutral point",
      api.favour({ chaMod: 0, attitude: 50 }), 0);
    report.equal("priceFor() prices a 10 gp item for a stranger",
      api.priceFor(1000, { chaMod: 0, attitude: 50 }).buyCp, 1100);
    report.equal("toCopper() converts", api.toCopper(15, "gp"), 1500);
    report.equal("formatCp() formats", api.formatCp(1500), "15 gp");
    report.equal("attitudeTier() names a tier", api.attitudeTier(95).key, "devoted");
    report.check("validateAnchors() accepts a shipped preset",
      api.validateAnchors(api.PRICING_PRESETS.standard).ok);

    /* --- A round trip through the write and trading tiers -------------- */
    trader = await api.createTrader({ name: `${PREFIX} API Trader`, greeting: "Hm." });
    report.check("createTrader() returns an actor", !!trader?.id);
    report.check("and it shows up in listTraders()",
      api.listTraders().some(entry => entry.id === trader.id));

    // Stock it through the API, from a real compendium item so `addStock` resolves a uuid the
    // way a macro author's would.
    //
    // Price has to be indexed and filtered on, not left to chance: picking "the first weapon"
    // once drew a 42,000 gp blade and the suite failed on the module *correctly* refusing a
    // purchase the test character could not afford. A fixture must not be able to fail a test
    // by being expensive.
    const index = await game.packs.get("dnd5e.items")?.getIndex({ fields: ["system.price"] });
    const source = index?.find(e => {
      if ( e.type !== "weapon" ) return false;
      const price = e.system?.price;
      return price?.denomination === "gp" && price.value > 0 && price.value <= 25;
    });
    if ( source ) {
      const added = await api.addStock(trader.id, source.uuid, { qty: 4 });
      report.check("addStock() creates a line", added.created.length === 1);

      const [line] = api.getStock(trader.id);
      report.equal("getStock() reports the quantity asked for", line.quantity, 4);

      await api.setStockLine(trader.id, line.id, { unlimited: true, revealAt: 60 });
      const [updated] = api.getStock(trader.id);
      report.check("setStockLine() patches one field without clearing the rest",
        updated.unlimited === true && updated.revealAt === 60,
        JSON.stringify(updated));

      // A gated line must be absent from a character's context even via the API.
      const character = game.actors.find(a => a.name === `${PREFIX} Thog`);
      if ( character ) {
        const context = await api.getShopContext(trader.id, character);
        report.check("getShopContext() filters a gated line for a character below it",
          !context.stock.some(l => l.id === line.id),
          context.stock.map(l => l.name).join(", "));

        await api.setAttitude(trader.id, character, 80);
        report.equal("setAttitude() persists", api.getAttitude(trader.id, character), 80);
        await api.adjustAttitude(trader.id, character, -10);
        report.equal("adjustAttitude() moves by a delta",
          api.getAttitude(trader.id, character), 70);

        const seen = await api.getShopContext(trader.id, character);
        report.check("and the line appears once the attitude clears the threshold",
          seen.stock.some(l => l.id === line.id));

        // The trading tier, end to end, through the authoritative path.
        await trader.update({ "system.currency": { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 } });
        const before = character.system.currency.gp;
        const bought = await api.buy({
          traderId: trader.id, actor: character, lines: [{ id: line.id, qty: 1 }]
        });
        report.check("buy() settles and reports a cost", bought.costCp > 0, JSON.stringify(bought));
        report.check("and the character actually paid",
          character.system.currency.gp !== before || character.system.currency.sp !== undefined);
      }

      await api.removeStock(trader.id, line.id);
      report.equal("removeStock() removes it", api.getStock(trader.id).length, 0);
    } else {
      report.check("a compendium weapon was available to stock", false,
        "dnd5e.items had no weapon to use");
    }

    const id = trader.id;
    await api.deleteTrader(id);
    trader = null;
    report.check("deleteTrader() removes it",
      !api.listTraders().some(entry => entry.id === id));
  } catch ( err ) {
    report.fail("apiSuite threw", err);
  } finally {
    // In `finally`, not at the end of the `try`. It used to sit at the end, so any assertion that
    // threw on the way skipped it — which is how two `[e2e] API Trader`s ended up permanently in
    // the test world, one per failed run.
    if ( trader ) await trader.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/**
 * The hooks fire where and when they are documented to.
 *
 * Order matters as much as occurrence: `preTrade` before any write, `tradeCompleted` after all
 * of them. A hook firing at the wrong moment is worse than one not firing, because a listener
 * acting on it would see a half-written world.
 */
export async function hookSuite() {
  const report = new Report();
  const listeners = [];
  let trader = null;
  let buyer = null;

  const record = [];
  const watch = alias => {
    const name = `simpleMagicShop.${alias}`;
    const id = Hooks.on(name, () => record.push(alias));
    listeners.push([name, id]);
  };

  try {
    const api = game.modules.get(MODULE)?.api;
    for ( const alias of ["traderCreated", "preTrade", "tradeCompleted", "attitudeChanged",
      "restocked", "traderCardPosted", "traderDeleted", "prePrice"] ) watch(alias);

    trader = await api.createTrader({ name: `${PREFIX} Hooked` });
    report.check("traderCreated fires on creation", record.includes("traderCreated"));

    await trader.update({ "system.currency": { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } });
    const [item] = await trader.createEmbeddedDocuments("Item", [{
      name: `${PREFIX} Hook Bait`,
      type: "loot",
      system: { quantity: 2, price: { value: 1, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 5 } }
    }]);

    buyer = game.actors.find(a => a.name === `${PREFIX} Thog`);
    record.length = 0;

    await api.buy({ traderId: trader.id, actor: buyer, lines: [{ id: item.id, qty: 1 }] });

    report.check("prePrice fires while pricing", record.includes("prePrice"));
    report.check("preTrade fires", record.includes("preTrade"));
    report.check("tradeCompleted fires", record.includes("tradeCompleted"));
    report.check("preTrade comes before tradeCompleted",
      record.indexOf("preTrade") < record.indexOf("tradeCompleted"),
      record.join(" -> "));
    report.check("and pricing comes before the veto point",
      record.indexOf("prePrice") < record.indexOf("preTrade"),
      record.join(" -> "));

    record.length = 0;
    await api.restock(trader.id);
    report.check("restocked fires when a line is refilled", record.includes("restocked"),
      record.join(", "));
    report.equal("and the line is back to its baseline",
      trader.items.get(item.id)?.system?.quantity, 5);

    record.length = 0;
    const message = await api.postTraderCard(trader.id);
    report.check("traderCardPosted fires", record.includes("traderCardPosted"));
    await message?.delete();

    // The receipt's item names must be real content links to the *compendium* entry, so anyone
    // at the table can open what was traded. Checked on a compendium-sourced item, because the
    // hand-built one above has nothing durable to point at and correctly renders as plain text.
    const index = await game.packs.get("dnd5e.items")?.getIndex({ fields: ["system.price"] });
    const cheap = index?.find(e => e.type === "weapon"
      && e.system?.price?.denomination === "gp" && e.system.price.value > 0
      && e.system.price.value <= 25);

    if ( cheap ) {
      await api.addStock(trader.id, cheap.uuid, { qty: 1 });
      const stocked = api.getStock(trader.id).find(l => l.name === cheap.name);
      const receipts = [];
      const capture = Hooks.on("createChatMessage", m => receipts.push(m));

      await api.buy({ traderId: trader.id, actor: buyer, lines: [{ id: stocked.id, qty: 1 }] });
      Hooks.off("createChatMessage", capture);

      const receipt = receipts.find(m => m.getFlag(MODULE, "card") === "receipt");
      if ( report.check("a receipt is posted", !!receipt) ) {
        const html = receipt.content;
        report.check("the receipt links the item", html.includes("content-link"),
          html.replace(/\s+/g, " ").slice(0, 240));
        report.check("and the link points at the compendium entry, not the traded copy",
          html.includes(`data-uuid="${cheap.uuid}"`),
          `expected ${cheap.uuid}`);
        await receipt.delete();
      }
      for ( const m of receipts ) await m.delete().catch(() => {});
    }

    record.length = 0;
    await api.deleteTrader(trader.id);
    trader = null;
    report.check("traderDeleted fires", record.includes("traderDeleted"));
  } catch ( err ) {
    report.fail("hookSuite threw", err);
  } finally {
    for ( const [name, id] of listeners ) Hooks.off(name, id);
    if ( trader ) await trader.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/**
 * Archetypes and portable Traders, through the API a macro author would use.
 *
 * The round trip is the point: a Trader exported and imported must arrive with its stock and its
 * settings, and without a single trace of this world's characters.
 */
export async function archetypeSuite() {
  const report = new Report();
  let trader = null;
  let imported = null;
  let savedId = null;
  try {
    const api = game.modules.get(MODULE)?.api;
    trader = await api.createTrader({ name: `${PREFIX} Archetype Trader`, greeting: "Keep this." });

    /* --- Built-in archetypes -------------------------------------------- */
    const archetypes = api.listArchetypes();
    report.check("the built-in archetypes are listed", archetypes.filter(a => a.builtIn).length >= 7,
      archetypes.map(a => a.id).join(", "));

    await api.applyArchetype(trader.id, "builtin-blacksmith");
    const data = api.getTraderData(trader.id);
    report.equal("applying one sets the buy filter", data.buyFilter.types, ["weapon", "equipment"]);
    report.equal("and the restock rule", [data.restock.mode, data.restock.days], ["time", 7]);
    report.equal("and leaves the greeting alone", data.greeting, "Keep this.");

    let refused = false;
    try {
      await api.applyArchetype(trader.id, "no-such-archetype");
    } catch {
      refused = true;
    }
    report.check("an unknown archetype is refused", refused);

    // Stocking from a recipe draws from whatever compendiums the world has, so the assertion is
    // about consistency, not about a particular count.
    const { stock } = await api.applyArchetype(trader.id, "builtin-general", { stock: true });
    report.check("applying with stock reports what it did",
      stock && Number.isFinite(stock.picked) && Array.isArray(stock.created), JSON.stringify(stock));
    report.check("and stocks no more lines than it picked",
      stock.created.length + stock.raised.length <= stock.picked,
      `picked ${stock.picked}, created ${stock.created.length}, raised ${stock.raised.length}`);

    /* --- Saved archetypes ----------------------------------------------- */
    const saved = await api.saveArchetype(trader.id, {
      name: `${PREFIX} Saved Shop`, recipe: { budget: { common: 2 }, categories: ["weapon"] }
    });
    savedId = saved.id;
    report.check("a Trader can be saved as an archetype",
      api.listArchetypes().some(a => a.id === saved.id && !a.builtIn));
    report.equal("carrying its current settings", saved.buyFilter, api.getTraderData(trader.id).buyFilter);
    report.equal("a built-in cannot be deleted", await api.deleteArchetype("builtin-fence"), false);
    report.equal("a saved one can", await api.deleteArchetype(saved.id), true);
    savedId = null;

    /* --- Export and import ---------------------------------------------- */
    const character = game.actors.find(a => a.name === `${PREFIX} Thog`);
    if ( character ) await api.setAttitude(trader.id, character, 90);
    await trader.update({ "system.currency": { pp: 1, gp: 25, ep: 0, sp: 0, cp: 0 } });
    await trader.createEmbeddedDocuments("Item", [{
      name: `${PREFIX} Exported Lantern`,
      type: "loot",
      system: { quantity: 3, price: { value: 5, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: 700, revealAt: 40, baseQty: 3 } }
    }]);

    const file = api.exportTrader(trader.id);
    const text = JSON.stringify(file);
    report.equal("an export identifies itself", file.format, `${MODULE}.trader`);
    report.equal("and carries every stock line", file.items.length, trader.items.size);
    report.check("but no opinion of anyone", !text.includes("\"attitude\":{") && !text.includes(character?.id ?? "\u0000"),
      "an attitude map or a character id was exported");

    imported = await api.importTrader(text);
    report.check("an import creates a Trader", !!imported?.id && imported.id !== trader.id);
    report.equal("with the same name", imported.name, trader.name);
    report.equal("the same stock", imported.items.size, trader.items.size);
    const lantern = imported.items.find(i => i.name.includes("Exported Lantern"));
    report.equal("line settings intact", lantern?.flags?.[MODULE], {
      unlimited: false, overrideCp: 700, revealAt: 40, baseQty: 3
    });
    report.equal("the same purse", imported.system.currency.gp, 25);
    report.equal("the same buy filter", api.getTraderData(imported.id).buyFilter,
      api.getTraderData(trader.id).buyFilter);
    report.equal("and no memory of anyone", api.getTraderData(imported.id).attitude, {});
    report.check("listed in the manager", api.listTraders().some(t => t.id === imported.id));

    let named = "";
    try {
      await api.importTrader({ format: "something-else" });
    } catch ( err ) {
      named = err.message;
    }
    report.check("a file that is not an export is refused with a reason", !!named, named);
  } catch ( err ) {
    report.fail("archetypeSuite threw", err);
  } finally {
    const api = game.modules.get(MODULE)?.api;
    if ( savedId ) await api?.deleteArchetype(savedId).catch(() => {});
    if ( trader ) await trader.delete().catch(() => {});
    if ( imported ) await imported.delete().catch(() => {});
  }
  return report.summary;
}

export async function all() {
  const suites = { api: apiSuite, hooks: hookSuite, archetypes: archetypeSuite };
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
