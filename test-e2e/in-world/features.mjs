/**
 * Rollback, item state on transfer, full-value goods, real magic items, and haggling — against real
 * documents and the real Dungeon Master's Guide pack.
 *
 * Runs on the GM's client. The two-client halves (showing a shop to players, a player haggling, a
 * GM with two tabs open) live in `cross.mjs` and `run.mjs`, since only a second client can show them.
 */

const MODULE = "sogrom-simple-dnd5e-magic-shop";
const BASE = `/modules/${MODULE}/scripts`;
const PREFIX = "[e2e]";
const DMG_PACK = "dnd-dungeon-masters-guide.equipment";

/** Mirrors `trade.mjs`'s reporter; kept local so this file can be run on its own. */
class Report {
  cases = [];

  check(name, condition, detail = "") {
    this.cases.push({ name, pass: !!condition, detail: condition ? "" : String(detail) });
    return !!condition;
  }

  equal(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(name, pass, pass ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  async rejects(name, fn, matcher) {
    try {
      await fn();
      return this.check(name, false, "expected a refusal, but it went through");
    } catch ( err ) {
      if ( matcher && !matcher.test(err.message) ) return this.check(name, false, `refused, but with: ${err.message}`);
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
  const [registry, trader, pricing, transaction, context, enchant, haggle, stock] = await Promise.all([
    import(`${BASE}/data/registry.mjs`),
    import(`${BASE}/data/trader.mjs`),
    import(`${BASE}/data/pricing.mjs`),
    import(`${BASE}/trade/transaction.mjs`),
    import(`${BASE}/trade/context.mjs`),
    import(`${BASE}/data/enchant.mjs`),
    import(`${BASE}/trade/haggle.mjs`),
    import(`${BASE}/data/stock.mjs`)
  ]);
  return { registry, trader, pricing, transaction, context, enchant, haggle, stock };
}

const api = () => game.modules.get(MODULE).api;
const cpOf = (mod, actor) => mod.pricing.totalCp(actor.system.currency);
const named = (actor, text) => actor.items.find(i => i.name.includes(text));

async function freshTrader(mod, { gp = 500, name = `${PREFIX} Feature Till`, items = [] } = {}) {
  const existing = game.actors.find(a => a.name === name);
  if ( existing ) await existing.delete();
  const actor = await mod.registry.createTrader({ name });
  await actor.update({ "system.currency": { pp: 0, gp, ep: 0, sp: 0, cp: 0 } });
  if ( items.length ) await actor.createEmbeddedDocuments("Item", items);
  return actor;
}

async function freshCharacter(name, { cha = 10, gp = 100, items = [] } = {}) {
  const existing = game.actors.find(a => a.name === name);
  if ( existing ) await existing.delete();
  const actor = await Actor.create({
    name, type: "character",
    system: { abilities: { cha: { value: cha } }, currency: { pp: 0, gp, ep: 0, sp: 0, cp: 0 } }
  });
  if ( items.length ) await actor.createEmbeddedDocuments("Item", items);
  return actor;
}

const line = (extra = {}) => ({ [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 1, ...extra } });

/** A DMG item's uuid by its `system.identifier`. */
async function dmgUuid(identifier) {
  const pack = game.packs.get(DMG_PACK);
  if ( !pack ) return null;
  const index = await pack.getIndex({ fields: ["system.identifier"] });
  return index.find(e => e.system?.identifier === identifier)?.uuid ?? null;
}

/**
 * Make every d20 roll a given face on this client, for the duration of `fn`.
 * Foundry maps a uniform draw u to a face as `ceil((1 - u) * faces)`, so a high face needs a low u.
 */
async function withDice(face, fn) {
  const original = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = () => Math.min(0.999999, Math.max(0, (20 - face + 0.5) / 20));
  try {
    return await fn();
  } finally {
    CONFIG.Dice.randomUniform = original;
  }
}

/* -------------------------------------------- */

/** A write that fails partway through a trade is undone, and leaves no trace. */
export async function rollbackSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer; let hook;
  try {
    trader = await freshTrader(mod, { items: [
      { name: `${PREFIX} Rollback Blade`, type: "weapon", system: { quantity: 2, price: { value: 10, denomination: "gp" } }, flags: line({ baseQty: 2 }) }
    ] });
    buyer = await freshCharacter(`${PREFIX} Rollback Buyer`, { items: [
      { name: `${PREFIX} Rollback Dagger`, type: "weapon", system: { quantity: 1, price: { value: 20, denomination: "gp" } } }
    ] });
    const blade = named(trader, "Rollback Blade");
    const dagger = named(buyer, "Rollback Dagger");
    const before = { buyer: cpOf(mod, buyer), trader: cpOf(mod, trader) };

    // Another module refusing the granted item: Foundry creates nothing and throws nothing.
    hook = Hooks.on("preCreateItem", item => (item.parent?.id === buyer.id && item.name.includes("Blade") ? false : undefined));
    await report.rejects("a refused grant fails the trade", () => mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [{ id: dagger.id, qty: 1 }], goldCp: 0 }
    }), /undone/);
    Hooks.off("preCreateItem", hook);
    hook = null;

    report.equal("the buyer's coin is back", cpOf(mod, buyer), before.buyer);
    report.equal("the Trader's coin is back", cpOf(mod, trader), before.trader);
    report.equal("the shelf is back", named(trader, "Rollback Blade")?.system.quantity, 2);
    report.check("the sold dagger is back in the pack", named(buyer, "Rollback Dagger"));
    report.check("and it did not stay on the Trader's shelf", !named(trader, "Rollback Dagger"));
    report.equal("nothing was granted", buyer.items.filter(i => i.name.includes("Blade")).length, 0);
    report.equal("nothing reached the ledger", mod.trader.ledgerOf(trader).length, 0);

    // The last of a line is deleted by a purchase; a rollback must bring the row back.
    await blade.update({ "system.quantity": 1 });
    hook = Hooks.on("preCreateItem", item => (item.parent?.id === buyer.id && item.name.includes("Blade") ? false : undefined));
    await report.rejects("buying the last one and failing is refused", () => mod.transaction.settle({
      trader, actor: buyer, intent: { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [], goldCp: 0 }
    }), /undone/);
    Hooks.off("preCreateItem", hook);
    hook = null;
    const restored = trader.items.get(blade.id);
    report.check("a deleted line is restored with its own id", !!restored, "the line did not come back");
    report.equal("and its shop settings", restored?.flags?.[MODULE]?.baseQty, 2);

    // A refusal before anything is written keeps its own message.
    await buyer.update({ "system.currency.gp": 0 });
    await report.rejects("a refusal before any write keeps its reason", () => mod.transaction.settle({
      trader, actor: buyer, intent: { mode: "trade", buy: [{ id: blade.id, qty: 1 }], sell: [], goldCp: 0 }
    }), /short/);
  } catch ( err ) {
    report.fail("rollbackSuite threw", err);
  } finally {
    if ( hook ) Hooks.off("preCreateItem", hook);
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/** Equipped and attuned belong to whoever was using the item; they never cross the counter. */
export async function transferStateSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    trader = await freshTrader(mod, { items: [
      { name: `${PREFIX} Worn Shield`, type: "equipment",
        system: { quantity: 1, price: { value: 10, denomination: "gp" }, equipped: true, type: { value: "shield" } },
        flags: line() }
    ] });
    buyer = await freshCharacter(`${PREFIX} Attuned Seller`, { items: [
      { name: `${PREFIX} Attuned Cloak`, type: "equipment",
        system: { quantity: 1, price: { value: 30, denomination: "gp" }, equipped: true, attunement: "required", attuned: true, properties: ["mgc"], rarity: "uncommon", type: { value: "clothing" } } }
    ] });

    const ctx = mod.context.buildShopContext(trader, buyer);
    const cloakLine = ctx.pack.find(l => l.name.includes("Attuned Cloak"));
    report.check("the shop tells the player the cloak is equipped", cloakLine?.equipped === true);
    report.check("and attuned", cloakLine?.attuned === true);

    const cloak = named(buyer, "Attuned Cloak");
    const shield = named(trader, "Worn Shield");
    await mod.transaction.settle({
      trader, actor: buyer,
      intent: { mode: "trade", buy: [{ id: shield.id, qty: 1 }], sell: [{ id: cloak.id, qty: 1 }], goldCp: 0 }
    });

    const shelved = named(trader, "Attuned Cloak");
    report.check("the sold cloak reaches the shelf", !!shelved);
    report.equal("unequipped", shelved?.system.equipped, false);
    report.equal("and unattuned", shelved?.system.attuned, false);
    const bought = named(buyer, "Worn Shield");
    report.check("the bought shield reaches the pack", !!bought);
    report.equal("unequipped, though the Trader's copy was", bought?.system.equipped, false);
  } catch ( err ) {
    report.fail("transferStateSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/** Gems, art objects and trade goods trade at their value, and earn no goodwill. */
export async function fullValueSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    trader = await freshTrader(mod, { gp: 1000, items: [
      { name: `${PREFIX} Ruby`, type: "loot", system: { quantity: 2, price: { value: 100, denomination: "gp" }, type: { value: "gem" } }, flags: line({ baseQty: 2 }) },
      { name: `${PREFIX} Plain Sack`, type: "loot", system: { quantity: 2, price: { value: 100, denomination: "gp" }, type: { value: "gear" } }, flags: line({ baseQty: 2 }) }
    ] });
    // Charisma 3: a stranger this graceless pays well over list for ordinary goods.
    buyer = await freshCharacter(`${PREFIX} Gem Buyer`, { cha: 3, gp: 1000 });

    const ctx = mod.context.buildShopContext(trader, buyer);
    const ruby = ctx.stock.find(l => l.name.includes("Ruby"));
    const sack = ctx.stock.find(l => l.name.includes("Plain Sack"));
    report.equal("a gem is offered at its value", ruby?.buyCp, 10_000);
    report.check("an ordinary item of the same value is not", sack?.buyCp > 10_000, `sack=${sack?.buyCp}`);
    report.check("and the payload marks the gem", ruby?.fixed === true);

    const receipt = await mod.transaction.settle({
      trader, actor: buyer, intent: { mode: "trade", buy: [{ id: ruby.id, qty: 1 }], sell: [], goldCp: 0 }
    });
    report.equal("settlement charges the same", receipt.costCp, 10_000);
    report.equal("buying a gem earns no goodwill", mod.trader.spendFor(trader, buyer).lifetimeCp, 0);

    const held = named(buyer, "Ruby");
    const sale = await mod.transaction.settle({
      trader, actor: buyer, intent: { mode: "trade", buy: [], sell: [{ id: held.id, qty: 1 }], goldCp: 0 }
    });
    report.equal("and selling it back pays the same", sale.creditCp, 10_000);
  } catch ( err ) {
    report.fail("fullValueSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/** DMG templates become real items on the shelf, and reach a buyer as real magic items. */
export async function enchantSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let buyer;
  try {
    const weaponPlus = await dmgUuid("weapon-1-2-or-3");
    const flameTongue = await dmgUuid("flame-tongue");
    const resistance = await dmgUuid("armor-of-resistance");
    if ( !report.check("the DMG templates are available", weaponPlus && flameTongue && resistance,
      "dnd-dungeon-masters-guide is not enabled in this world") ) return report.summary;

    trader = await freshTrader(mod, { gp: 10_000 });
    buyer = await freshCharacter(`${PREFIX} Magic Buyer`, { gp: 5000 });

    const enchantments = await api().getEnchantments(weaponPlus);
    report.equal("Weapon +1/+2/+3 offers three enchantments", enchantments.map(e => e.name),
      ["Weapon +1", "Weapon +2", "Weapon +3"]);
    const plusOne = enchantments[0];
    const longsword = plusOne.bases.find(b => b.name === "Longsword");
    report.check("with the system's Longsword among the bases", !!longsword, plusOne.bases.map(b => b.name).join(", "));

    await api().addEnchantedStock(trader.id, { template: weaponPlus, enchantment: plusOne.key, base: longsword.uuid });
    const made = trader.items.find(i => i.flags?.[MODULE]?.madeFrom?.template === weaponPlus);
    report.equal("the Trader stocks a Longsword +1", made?.name, "Longsword +1");
    report.equal("uncommon", made?.system.rarity, "uncommon");
    report.equal("with a +1 bonus", Number(made?.system.magicalBonus), 1);
    report.equal("priced at the base plus the DMG's +400 gp", mod.stock.effectiveValueCp(made, mod.trader.stockLine(made)), 41_500);
    report.check("and not the hollow template", made?.system.type?.value === "martialM", made?.system.type?.value);

    await api().addEnchantedStock(trader.id, { template: weaponPlus, enchantment: plusOne.key, base: longsword.uuid });
    report.equal("stocking it again raises the line", trader.items.filter(i => i.name === "Longsword +1").map(i => i.system.quantity), [2]);

    const flame = (await api().getEnchantments(flameTongue))[0];
    await api().addEnchantedStock(trader.id, {
      template: flameTongue, enchantment: flame.key, base: flame.bases.find(b => b.name === "Longsword").uuid
    });
    const blade = trader.items.find(i => i.flags?.[MODULE]?.madeFrom?.template === flameTongue);
    report.check("a Flame Tongue Longsword is a separate line", blade && blade.id !== made.id);
    report.check("carrying its Ablaze activity", blade && blade.system.activities.size > named(trader, "Longsword +1").system.activities.size);

    const res = (await api().getEnchantments(resistance)).find(e => e.name.includes("Fire"));
    await api().addEnchantedStock(trader.id, { template: resistance, enchantment: res.key, base: res.bases[0].uuid });
    const armour = trader.items.find(i => i.flags?.[MODULE]?.madeFrom?.template === resistance);
    report.check("Armor of Fire Resistance carries its resistance rider",
      armour?.effects.some(e => e.name === "Fire Resistance"), armour?.effects.map(e => e.name).join(", "));

    // Buying it: the enchantment travels, and the buyer holds a real magic weapon.
    await mod.transaction.settle({
      trader, actor: buyer, intent: { mode: "trade", buy: [{ id: made.id, qty: 1 }], sell: [], goldCp: 0 }
    });
    const owned = buyer.items.find(i => i.name === "Longsword +1");
    report.check("the buyer holds a Longsword +1", !!owned, buyer.items.map(i => i.name).join(", "));
    report.equal("which is still +1 on their sheet", Number(owned?.system.magicalBonus), 1);
    report.check("with the enchantment applied", owned?.effects.some(e => e.isAppliedEnchantment));
    report.check("and none of the shop's bookkeeping", !owned?.flags?.[MODULE]);

    // With nobody to choose, a template is made at random rather than stocked hollow.
    const random = await api().addStock(trader.id, weaponPlus);
    const randomMade = random.created[0];
    report.check("adding a template without choosing makes a real item",
      randomMade?.flags?.[MODULE]?.madeFrom?.template === weaponPlus && randomMade?.system.type?.value,
      randomMade?.name);

    // A spell becomes a scroll of it.
    const spells = await dnd5e.applications.CompendiumBrowser.fetch(Item, { types: new Set(["spell"]), index: true });
    const spell = spells.find(s => s.name === "Fireball") ?? spells[0];
    const scroll = await api().addStock(trader.id, spell.uuid);
    report.check("a spell is stocked as a scroll of it",
      scroll.created[0]?.type === "consumable" && scroll.created[0]?.name.includes(spell.name), scroll.created[0]?.name);
  } catch ( err ) {
    report.fail("enchantSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
    if ( buyer ) await buyer.delete().catch(() => {});
  }
  return report.summary;
}

/** The generator draws finished magic items and real scrolls, never hollow templates. */
export async function generatorSuite() {
  const report = new Report();
  const mod = await load();
  let trader;
  try {
    const weaponPlus = await dmgUuid("weapon-1-2-or-3");
    if ( !report.check("the DMG is available", weaponPlus) ) return report.summary;

    const pool = await mod.trader.stockPool();
    report.check("the pool no longer holds the hollow template", !pool.some(e => e.uuid === weaponPlus && !e.kind));
    report.check("it holds what can be made from it", pool.some(e => e.kind === "enchant" && e.uuid === weaponPlus));
    report.check("and real scrolls", pool.some(e => e.kind === "scroll"));

    trader = await freshTrader(mod);
    const result = await mod.trader.stockFromRecipe(trader, {
      budget: { uncommon: 6 }, categories: ["weapon", "equipment:heavy"], packs: [DMG_PACK]
    });
    report.check("a DMG-only weapons recipe stocks something", result.created.length > 0, JSON.stringify(result.shortfalls));
    const hollow = trader.items.filter(i => i.type === "weapon" && !i.system.type?.value);
    report.equal("and none of it is a weapon with no base", hollow.map(i => i.name), []);

    const scrolls = await mod.trader.stockFromRecipe(trader, { budget: { common: 3 }, categories: ["consumable:scroll"] });
    const blank = trader.items.filter(i => i.type === "consumable" && /^Spell Scroll/.test(i.name) && !i.system.activities.size);
    report.check("a scroll recipe stocks scrolls", scrolls.created.length > 0, JSON.stringify(scrolls.shortfalls));
    report.equal("with spells on them", blank.map(i => i.name), []);
  } catch ( err ) {
    report.fail("generatorSuite threw", err);
  } finally {
    if ( trader ) await trader.delete().catch(() => {});
  }
  return report.summary;
}

/** Haggling, rolled here on the GM's client, with the dice held so the outcome is known. */
export async function haggleSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let talker; let hook;
  try {
    trader = await freshTrader(mod);
    talker = await freshCharacter(`${PREFIX} Talker`, { cha: 16 });

    const win = await withDice(20, () => mod.haggle.haggle({ trader, actor: talker, skill: "per" }));
    report.check("a natural 20 persuades", win.success, JSON.stringify(win));
    report.equal("DC 15 against an ordinary Trader", win.dc, 15);
    report.equal("and warms the Trader by 5", mod.trader.getAttitude(trader, talker), 55);

    await trader.update({ "system.abilities.int.value": 30 });
    const lose = await withDice(1, () => mod.haggle.haggle({ trader, actor: talker, skill: "per" }));
    report.check("a natural 1 against a clever Trader fails", !lose.success);
    report.equal("the DC is the Trader's Intelligence", lose.dc, 30);
    report.equal("and cools the Trader by 5", mod.trader.getAttitude(trader, talker), 50);
    await report.rejects("the same approach is locked for the day",
      () => withDice(20, () => mod.haggle.haggle({ trader, actor: talker, skill: "per" })), /already tried/);
    const other = await withDice(1, () => mod.haggle.haggle({ trader, actor: talker, skill: "dec" }));
    report.check("another approach can still be tried", other.skill === "dec");

    const ctx = mod.context.buildShopContext(trader, talker);
    report.equal("the shop knows which approaches are locked",
      ctx.haggle.skills.filter(s => s.locked).map(s => s.key), ["per", "dec"]);

    hook = Hooks.on(`simpleMagicShop.preHaggle`, () => false);
    await report.rejects("a preHaggle listener can refuse", () => mod.haggle.haggle({ trader, actor: talker, skill: "itm" }));
    Hooks.off(`simpleMagicShop.preHaggle`, hook);
    hook = null;
    report.check("and a refusal locks nothing", !mod.trader.haggleRecordFor(trader, talker).itm);

    await report.rejects("a skill that is not a Charisma skill is refused",
      () => mod.haggle.haggle({ trader, actor: talker, skill: "ath" }), /not a way/);
  } catch ( err ) {
    report.fail("haggleSuite threw", err);
  } finally {
    if ( hook ) Hooks.off(`simpleMagicShop.preHaggle`, hook);
    if ( trader ) await trader.delete().catch(() => {});
    if ( talker ) await talker.delete().catch(() => {});
  }
  return report.summary;
}

/** A Trader holds at most the world's limit of lines, whichever way stock arrives. */
export async function stockLimitSuite() {
  const report = new Report();
  const mod = await load();
  let trader; let seller; let imported;
  // The suite is written against the default, whatever this world was left at.
  const previousLimit = game.settings.get(MODULE, "maxStockLines");
  try {
    await game.settings.set(MODULE, "maxStockLines", 150);
    const rows = n => Array.from({ length: n }, (_, i) => ({
      name: `${PREFIX} Crate ${i}`, type: "loot",
      system: { quantity: 1, price: { value: 1, denomination: "gp" } }, flags: line()
    }));
    trader = await freshTrader(mod, { name: `${PREFIX} Crowded Shop`, gp: 1000, items: rows(148) });
    report.equal("a Trader can hold 148 lines", mod.trader.stockEntries(trader).length, 148);

    // Through the module: two fit, the third is reported rather than created.
    const extra = ["Lantern", "Rope", "Tent"].map(name => ({
      name: `${PREFIX} ${name}`, type: "loot", system: { quantity: 1, price: { value: 2, denomination: "gp" } }
    }));
    const added = await mod.trader.addMadeStock(trader, extra);
    report.equal("adding three to 148 creates two", added.created.length, 2);
    report.equal("and reports the one that did not fit", added.full.length, 1);
    report.equal("leaving exactly 150 lines", mod.trader.stockEntries(trader).length, 150);

    // Raising a line already stocked needs no room.
    const raised = await mod.trader.addMadeStock(trader, [extra[0]]);
    report.check("a full Trader still raises a line it already has", raised.raised.length === 1 && !raised.full.length,
      JSON.stringify({ raised: raised.raised.length, full: raised.full.length }));

    // Straight onto the actor sheet: the backstop refuses.
    const direct = await trader.createEmbeddedDocuments("Item", [{
      name: `${PREFIX} Smuggled Barrel`, type: "loot", system: { quantity: 1, price: { value: 1, denomination: "gp" } }
    }]);
    report.equal("an item dropped on a full Trader's sheet is refused", direct.length, 0);

    // A character selling something new.
    seller = await freshCharacter(`${PREFIX} Seller`, { gp: 50, items: [
      { name: `${PREFIX} Odd Idol`, type: "loot", system: { quantity: 1, price: { value: 10, denomination: "gp" } } },
      { name: `${PREFIX} Rope`, type: "loot", system: { quantity: 1, price: { value: 2, denomination: "gp" } } }
    ] });
    const ctx = mod.context.buildShopContext(trader, seller);
    const idolLine = ctx.pack.find(l => l.name.includes("Odd Idol"));
    report.check("the shop greys out something a full Trader has no room for", idolLine?.blocked === true, JSON.stringify(idolLine));
    report.check("but not something it already stocks", ctx.pack.find(l => l.name.includes("Rope"))?.blocked === false);

    const idol = named(seller, "Odd Idol");
    await report.rejects("selling something new to a full Trader is refused", () => mod.transaction.settle({
      trader, actor: seller, intent: { mode: "trade", buy: [], sell: [{ id: idol.id, qty: 1 }], goldCp: 0 }
    }), /no room/);
    const rope = named(seller, "Rope");
    await mod.transaction.settle({
      trader, actor: seller, intent: { mode: "trade", buy: [], sell: [{ id: rope.id, qty: 1 }], goldCp: 0 }
    });
    report.equal("selling something it already stocks merges into the line", mod.trader.stockEntries(trader).length, 150);

    // Buying out a line in the same deal makes room for the new one.
    const crate = named(trader, "Crate 0");
    await mod.transaction.settle({
      trader, actor: seller,
      intent: { mode: "trade", buy: [{ id: crate.id, qty: 1 }], sell: [{ id: idol.id, qty: 1 }], goldCp: 0 }
    });
    report.check("buying the last of a line makes room for a sale in the same deal", !!named(trader, "Odd Idol"));
    report.equal("and the shelves stay at 150", mod.trader.stockEntries(trader).length, 150);

    // Import: a file with more than the limit arrives with the limit.
    const file = api().exportTrader(trader.id);
    file.trader.name = `${PREFIX} Crowded Copy`;
    file.items.push(...rows(5).map(r => ({ ...r, name: `${r.name} (extra)` })));
    const result = await mod.registry.importTrader(JSON.stringify(file));
    imported = result.actor;
    report.equal("an import keeps at most 150 lines", mod.trader.stockEntries(imported).length, 150);
    report.equal("and says how many it left out", result.dropped, 5);

    // The GM's slider: raised, the same full Trader takes more.
    await game.settings.set(MODULE, "maxStockLines", 160);
    const more = await mod.trader.addMadeStock(trader, [{
      name: `${PREFIX} Late Delivery`, type: "loot", system: { quantity: 1, price: { value: 1, denomination: "gp" } }
    }]);
    report.equal("raising the limit to 160 makes room on a full Trader", more.created.length, 1);
    report.equal("which then holds 151 lines", mod.trader.stockEntries(trader).length, 151);

    // Lowered below what a Trader holds, nothing is removed and nothing new goes in.
    await game.settings.set(MODULE, "maxStockLines", 100);
    const refused = await mod.trader.addMadeStock(trader, [{
      name: `${PREFIX} Too Late`, type: "loot", system: { quantity: 1, price: { value: 1, denomination: "gp" } }
    }]);
    report.equal("lowering the limit removes no stock", mod.trader.stockEntries(trader).length, 151);
    report.equal("but a Trader over it takes nothing new", refused.full.length, 1);
  } catch ( err ) {
    report.fail("stockLimitSuite threw", err);
  } finally {
    await game.settings.set(MODULE, "maxStockLines", previousLimit).catch(() => {});
    if ( trader ) await trader.delete().catch(() => {});
    if ( imported ) await imported.delete().catch(() => {});
    if ( seller ) await seller.delete().catch(() => {});
  }
  return report.summary;
}

/** Run every suite in this file. */
export async function all() {
  const suites = {
    rollback: rollbackSuite,
    transferState: transferStateSuite,
    fullValue: fullValueSuite,
    enchant: enchantSuite,
    generator: generatorSuite,
    haggle: haggleSuite,
    stockLimit: stockLimitSuite
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

/* -------------------------------------------- */
/*  Cross-client helpers (called from run.mjs)  */
/* -------------------------------------------- */

/** GM: a Trader with one stock line, for the show and two-tab checks. */
export async function makeTwoTabTrader() {
  const mod = await load();
  const trader = await freshTrader(mod, { name: `${PREFIX} Two Tabs`, items: [
    { name: `${PREFIX} Torch`, type: "consumable", system: { quantity: 5, price: { value: 1, denomination: "gp" } }, flags: line({ baseQty: 5 }) }
  ] });
  return { traderId: trader.id, itemId: named(trader, "Torch").id };
}

/** GM: what one settlement should have left behind. */
export async function readTwoTabTrader({ traderId, characterName }) {
  const mod = await load();
  const trader = game.actors.get(traderId);
  const character = game.actors.find(a => a.name === characterName);
  const claim = await import(`${BASE}/trade/claim.mjs`);
  return {
    shelf: named(trader, "Torch")?.system.quantity ?? 0,
    ledger: mod.trader.ledgerOf(trader).length,
    held: named(character, "Torch")?.system.quantity ?? 0,
    siblings: claim.hasSiblings()
  };
}

/** GM: tidy the character's purchases and the Trader. */
export async function cleanupTwoTab({ traderId, characterName }) {
  const character = game.actors.find(a => a.name === characterName);
  const torches = character?.items.filter(i => i.name.includes("Torch")).map(i => i.id) ?? [];
  if ( torches.length ) await character.deleteEmbeddedDocuments("Item", torches);
  await game.actors.get(traderId)?.delete();
  return true;
}

/** GM: show a Trader to every player and report who got it. */
export async function showToPlayers({ traderId }) {
  return api().showToPlayers(traderId);
}

/** Any client: hold the dice at one face (for a GM-rolled check driven from a player's client). */
export async function holdDice({ face }) {
  globalThis.__e2eUniform ??= CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = () => Math.min(0.999999, Math.max(0, (20 - face + 0.5) / 20));
  return true;
}

/** Any client: let the dice go again. */
export async function releaseDice() {
  if ( globalThis.__e2eUniform ) CONFIG.Dice.randomUniform = globalThis.__e2eUniform;
  return true;
}
