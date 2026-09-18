/**
 * The in-world half of the memory suite: the things to repeat, and the counts to compare.
 *
 * Nothing here measures the heap. That needs the DevTools protocol, which only the Node side
 * holds (see `memory.mjs`). What this file offers is the *work* — every way a table uses the
 * module, done over and over — and the cheap structural counts that a leak moves before the heap
 * does: hook listeners, registered applications, tracked shops.
 *
 * Every scenario takes `{cycles}` and returns `{done}`, the number of cycles that got all the way
 * through. The runner asserts `done === cycles`, so a scenario that quietly stopped exercising
 * anything (a renamed action, a menu that no longer opens) fails rather than passes vacuously.
 */

const MODULE = "sogrom-simple-dnd5e-magic-shop";
const BASE = `/modules/${MODULE}/scripts`;
const PREFIX = "[e2e]";
const NAME = `${PREFIX} Memory`;

const api = () => game.modules.get(MODULE).api;
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll until `test` passes or `ms` runs out; returns whether it passed. */
async function until(test, ms = 3000) {
  for ( const end = Date.now() + ms; Date.now() < end; ) {
    if ( test() ) return true;
    await wait(25);
  }
  return !!test();
}

const doubleClick = element => element?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
const menuOpen = () => !!document.querySelector("#context-menu");

async function rightClick(element) {
  await until(() => !menuOpen());
  element?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  return until(menuOpen);
}

async function closeMenu() {
  ui.context?.close();
  await until(() => !menuOpen());
}

async function pickFromMenu(key) {
  const label = game.i18n.localize(`${MODULE}.shop.menu.${key}`);
  const entry = [...document.querySelectorAll("#context-menu .context-item")]
    .find(item => item.textContent.trim() === label);
  entry?.click();
  await until(() => !menuOpen());
  return !!entry;
}

/** Windows registered since `before` was taken: whatever an action just opened. */
const newWindows = before => [...foundry.applications.instances.values()].filter(a => !before.has(a));

/**
 * Close every window opened since `before`. A scenario has to leave the world as it found it, or
 * the window it forgot is charged to the module as a leak — a picker left open keeps its caller
 * alive through the callback it is waiting to answer, which is correct and not a leak at all.
 */
async function closeNewWindows(before) {
  for ( const app of newWindows(before) ) await app.close({ animate: false }).catch(() => {});
  return until(() => newWindows(before).length === 0, 2000);
}

/* -------------------------------------------- */
/*  Probes                                      */
/* -------------------------------------------- */

/**
 * The structural counts. A window that is closed but still registered, or a hook added per open,
 * shows up here after a handful of cycles, long before it is visible in megabytes.
 * @returns {Promise<object>}
 */
export async function probe() {
  const { ShopApp } = await import(`${BASE}/app/shop-app.mjs`);
  const { templateCacheStats } = await import(`${BASE}/data/enchant.mjs`);
  const hooks = {};
  let hookTotal = 0;
  for ( const [event, list] of Object.entries(Hooks.events ?? {}) ) {
    if ( !list?.length ) continue;
    hooks[event] = list.length;
    hookTotal += list.length;
  }
  return {
    hookTotal,
    hooks,
    applications: foundry.applications.instances.size,
    trackedShops: ShopApp.instances.length,
    // Every window this module draws carries the shell's class; its ids all start with the module's.
    shopElements: document.querySelectorAll(`.sogrom-shop, [id^="${MODULE}"]`).length,
    chatMessages: game.messages.size,
    templateCache: templateCacheStats()
  };
}

/* -------------------------------------------- */
/*  Fixture (GM)                                */
/* -------------------------------------------- */

/**
 * The Trader every scenario shops at, and a purse deep enough that no cycle runs out of coin.
 *
 * The open line is unlimited so buying never empties it, and the rare line is a one-off so the
 * right-click menu has both kinds of tile to act on.
 * @param {{characterName: string}} params
 * @returns {Promise<{traderId: string, actorId: string}>}
 */
export async function setup({ characterName }) {
  for ( const old of game.actors.filter(a => a.name === NAME) ) await old.delete();
  const character = game.actors.find(a => a.name === characterName);
  if ( !character ) throw new Error(`No character named "${characterName}"; run provision.mjs`);
  await character.update({ "system.currency": { pp: 0, gp: 100_000, ep: 0, sp: 0, cp: 0 } });

  const trader = await api().createTrader({ name: NAME, greeting: "Buy something or leave." });
  await trader.update({ "system.currency": { pp: 0, gp: 100_000, ep: 0, sp: 0, cp: 0 } });
  await trader.createEmbeddedDocuments("Item", [
    {
      name: `${PREFIX} Open Stock`,
      type: "loot",
      img: "icons/svg/item-bag.svg",
      system: { quantity: 50, price: { value: 1, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: true, overrideCp: null, revealAt: null, baseQty: 50 } }
    },
    {
      name: `${PREFIX} Limited Stock`,
      type: "loot",
      img: "icons/svg/coins.svg",
      system: { quantity: 10, price: { value: 2, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 10 } }
    },
    {
      name: `${PREFIX} Rare Stock`,
      type: "loot",
      img: "icons/svg/mystery-man.svg",
      system: { quantity: 1, price: { value: 30, denomination: "gp" }, rarity: "rare" },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 1 } }
    }
  ]);

  // One line stocked from a compendium, because "View item" opens the compendium entry and a tile
  // made from scratch has none to open.
  const pack = game.packs.get("dnd5e.items");
  const entry = (await pack?.getIndex())?.find(e => e.type === "weapon");
  let viewName = null;
  if ( entry ) {
    const { created } = await api().addStock(trader.id, [entry.uuid]);
    viewName = created?.[0]?.name ?? entry.name;
  }

  // Something in the character's pack to sell, a stack deep enough for every cycle.
  await character.createEmbeddedDocuments("Item", [{
    name: `${PREFIX} Pawn Stock`,
    type: "loot",
    img: "icons/svg/item-bag.svg",
    system: { quantity: 200, price: { value: 1, denomination: "gp" } }
  }]);

  // A party purse the player owns, for paying from a Group.
  const player = game.users.find(u => !u.isGM && u.character?.id === character.id);
  const group = await Actor.create({
    name: `${PREFIX} Memory Company`,
    type: "group",
    system: { members: [{ actor: character.id }], currency: { pp: 0, gp: 100_000, ep: 0, sp: 0, cp: 0 } },
    ownership: { default: 0, ...(player ? { [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } : {}) }
  });

  return { traderId: trader.id, actorId: character.id, groupId: group.id, viewName };
}

/** Remove the fixtures, and what their trades left on the character. */
export async function teardown({ traderId, groupId, characterName }) {
  await game.actors.get(traderId)?.delete();
  await game.actors.get(groupId)?.delete();
  for ( const extra of game.actors.filter(a => a.name.startsWith(`${NAME} `)) ) await extra.delete();
  const character = game.actors.find(a => a.name === characterName);
  const bought = character?.items.filter(i => i.name.startsWith(`${PREFIX} `) && i.name.endsWith("Stock")) ?? [];
  if ( bought.length ) await character.deleteEmbeddedDocuments("Item", bought.map(i => i.id));
  return true;
}

/** The chat message ids that exist now, so the messages a scenario posts can be removed after it. */
export async function chatMark() {
  return game.messages.map(m => m.id);
}

/**
 * Delete every message posted since {@link chatMark}. Receipts, haggle rolls and cards are real
 * documents the table keeps on purpose; they are not the module's memory to account for.
 */
export async function chatPurge({ keep }) {
  const kept = new Set(keep);
  const ids = game.messages.filter(m => !kept.has(m.id)).map(m => m.id);
  if ( ids.length ) await ChatMessage.deleteDocuments(ids);
  return ids.length;
}

/** Switch every client between the full-screen and windowed shells. */
export async function setDisplayMode({ mode }) {
  const was = game.settings.get(MODULE, "displayMode");
  await game.settings.set(MODULE, "displayMode", mode);
  return was;
}

/* -------------------------------------------- */
/*  Shop scenarios (any client)                 */
/* -------------------------------------------- */

/** Open a shop and wait for it to draw. `actorId` is for the GM, who has no character of their own. */
async function openShop(traderId, actorId) {
  const app = await api().openShop(traderId, actorId ? { actor: actorId } : {});
  await until(() => app?.rendered);
  return app?.rendered ? app : null;
}

const tileNamed = (app, text) => [...(app.element?.querySelectorAll(".shop-panel--stock .shop-tile") ?? [])]
  .find(tile => tile.dataset.name?.includes(text));

/**
 * Open and close a shop. The plainest cycle, and the one every other scenario builds on.
 * @param {{traderId: string, cycles: number, actorId?: string, viaEscape?: boolean}} params
 *   `viaEscape` closes it the way a player does in full-screen, with the Escape key.
 */
export async function shopCycles({ traderId, cycles, actorId, viaEscape = false }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = await openShop(traderId, actorId);
    if ( !app ) continue;
    await app.render({ parts: ["footer"] });
    await wait(20);
    const element = app.element;
    if ( viaEscape ) {
      // Escape closes with the animation, which Foundry lets run for up to a second before it
      // removes the element and unregisters the window. Waiting for that, rather than for
      // `rendered` to drop, is what tells a slow close from one that never finishes.
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await until(() => !element.isConnected && !foundry.applications.instances.has(app.id), 3000);
    } else {
      await app.close({ animate: false });
    }
    if ( !element.isConnected && !foundry.applications.instances.has(app.id) ) done++;
    await wait(20);
  }
  return { done };
}

/**
 * Use a shop the way a player does, then close it: every gesture and control on it.
 *
 * History on and off, typing in the search box and choosing a type, staging with a double-click
 * and taking back with one, the right-click menu, typing an offer in the coin boxes, clearing
 * the counter, and the refresh button.
 */
export async function shopUsed({ traderId, cycles, actorId }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = await openShop(traderId, actorId);
    if ( !app ) continue;
    const root = () => app.element;
    const click = async selector => {
      root().querySelector(selector)?.click();
      await wait(120);
    };

    await click('[data-action="toggleHistory"]');
    await click('[data-action="toggleHistory"]');

    const search = root().querySelector('[data-shop-search="stock"]');
    if ( search ) {
      search.value = "stock";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const category = root().querySelector('[data-shop-category="stock"]');
    if ( category?.options.length > 1 ) {
      category.value = category.options[1].value;
      category.dispatchEvent(new Event("change", { bubbles: true }));
      category.value = "";
      category.dispatchEvent(new Event("change", { bubbles: true }));
    }

    doubleClick(tileNamed(app, "Open Stock")?.querySelector(".shop-tile-button"));
    await until(() => !!root().querySelector(".shop-staged-row"));
    const staged = !!root().querySelector(".shop-staged-row");

    const menu = await rightClick(tileNamed(app, "Rare Stock")?.querySelector(".shop-tile-button"));
    if ( menu ) await pickFromMenu("addOne");
    await closeMenu();

    doubleClick(root().querySelector(".shop-staged-row"));
    await wait(120);

    const coin = root().querySelector('[data-shop-coin="gp"]');
    if ( coin ) {
      coin.value = "1";
      coin.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(60);
      coin.value = "";
      coin.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(60);
    }

    await click('[data-action="clearCounter"]');
    await click('[data-action="refresh"]');
    await wait(150);

    await app.close({ animate: false });
    if ( staged && menu && !app.rendered ) done++;
  }
  return { done };
}

/**
 * Buy one through the window: stage it, press confirm, wait for the settlement to land.
 * This is the path with the `#settling` guard, the post-trade refresh and the receipt.
 */
export async function shopConfirm({ traderId, cycles, actorId }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = await openShop(traderId, actorId);
    if ( !app ) continue;
    doubleClick(tileNamed(app, "Open Stock")?.querySelector(".shop-tile-button"));
    await until(() => app.element.querySelector(".shop-confirm")?.disabled === false);
    app.element.querySelector('[data-action="confirmTrade"]')?.click();
    // The counter empties once the settlement is back and the context has been re-read.
    const settled = await until(() => app.rendered && !app.element.querySelector(".shop-staged-row"), 8000);
    await wait(100);
    await app.close({ animate: false });
    if ( settled ) done++;
  }
  return { done };
}

/**
 * Drag a tile onto the counter and the row back off it, then sell one from the pack through the
 * window. Dragging carries its own listeners and state (`#drag`, the drop-zone highlight), and
 * selling is the other half of the counter from buying.
 */
export async function dragAndSell({ traderId, cycles, actorId }) {
  const { ShopApp } = await import(`${BASE}/app/shop-app.mjs`);
  const drag = async (from, to) => {
    const transfer = new DataTransfer();
    const fire = (target, type) => target?.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    fire(from, "dragstart");
    fire(to, "dragover");
    fire(to, "drop");
    fire(from, "dragend");
    await wait(150);
  };
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = await openShop(traderId, actorId);
    if ( !app ) continue;
    const root = () => app.element;

    await drag(tileNamed(app, "Open Stock")?.querySelector(".shop-tile-button"), root().querySelector(".shop-panel--stage"));
    const dragged = await until(() => !!root().querySelector(".shop-staged-row"));
    // A row goes back by being dropped on the panel it came from: bought goods on the shelves.
    const row = root().querySelector(".shop-staged-row");
    const side = row?.closest("[data-side]")?.dataset.side ?? "take";
    await drag(row, root().querySelector(`.shop-panel[data-side="${side}"]`));
    const undragged = await until(() => !root().querySelector(".shop-staged-row"));
    // Whatever the drag-back left, start the sale from an empty counter.
    root().querySelector('[data-action="clearCounter"]')?.click();
    await wait(120);

    const pawn = [...root().querySelectorAll(".shop-panel--pack .shop-tile")].find(t => t.dataset.name?.includes("Pawn Stock"));
    doubleClick(pawn?.querySelector(".shop-tile-button"));
    await until(() => root().querySelector(".shop-confirm")?.disabled === false);
    root().querySelector('[data-action="confirmTrade"]')?.click();
    const sold = await until(() => app.rendered && !root().querySelector(".shop-staged-row"), 8000);
    await wait(100);
    await app.close({ animate: false });
    if ( dragged && undragged && sold && !ShopApp.instances.length ) done++;
  }
  return { done };
}

/**
 * Shop paying from the party purse: open with the Group as payer, switch to the character's own
 * purse and back with the picker, buy one from the Group's coin.
 */
export async function payerCycles({ traderId, cycles, groupId }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = await api().openShop(traderId, { payer: groupId });
    if ( !(await until(() => app?.rendered)) ) continue;
    const pick = async value => {
      const select = app.element.querySelector("[data-shop-payer]");
      if ( !select ) return false;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(400);
      return true;
    };
    const own = game.user.character?.id ?? "";
    const switched = (await pick(own)) && (await pick(groupId));
    const line = game.actors.get(traderId)?.items.find(item => item.name === `${PREFIX} Open Stock`);
    let bought = false;
    try {
      await api().buy({ traderId, payer: groupId, lines: [{ id: line.id, qty: 1 }] });
      bought = true;
    } catch ( err ) {
      console.warn(`${PREFIX} memory: group purchase failed: ${err.message}`);
    }
    await wait(250);
    await app.close({ animate: false });
    if ( switched && bought ) done++;
  }
  return { done };
}

/** Buy one and sell it straight back, through the API. The macro path, with no window at all. */
export async function apiTrades({ traderId, cycles, actorId }) {
  const trader = () => game.actors.get(traderId);
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    try {
      // A player cannot resolve the Trader's items locally by permission, but Foundry replicates
      // them all the same (see docs/PLAN.md §6), so the line id is there to read.
      const line = trader()?.items.find(item => item.name === `${PREFIX} Limited Stock`);
      await api().buy({ traderId, actor: actorId, lines: [{ id: line.id, qty: 1 }] });
      const character = actorId ? game.actors.get(actorId) : game.user.character;
      const held = character.items.find(item => item.name === `${PREFIX} Limited Stock`);
      await api().sell({ traderId, actor: actorId, lines: [{ id: held.id, qty: 1 }] });
      done++;
    } catch ( err ) {
      console.warn(`${PREFIX} memory: trade cycle failed: ${err.message}`);
    }
  }
  return { done };
}

/** Haggle through the GM. The dice are held at 20 by the runner, so each one succeeds and none locks. */
export async function haggleCycles({ traderId, cycles }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    try {
      const outcome = await api().haggle({ traderId, skill: "per" });
      if ( outcome ) done++;
    } catch ( err ) {
      console.warn(`${PREFIX} memory: haggle cycle failed: ${err.message}`);
    }
  }
  return { done };
}

/**
 * Right-click a tile, choose "View item", close the sheet it opens, close the shop. The takeover
 * raises that sheet above the shop, which is the only path into `takeover.mjs` a player takes.
 */
export async function viewItemCycles({ traderId, cycles, actorId, viewName }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = await openShop(traderId, actorId);
    if ( !app ) continue;
    const before = new Set(foundry.applications.instances.values());
    if ( await rightClick(tileNamed(app, viewName)?.querySelector(".shop-tile-button")) ) {
      await pickFromMenu("view");
    }
    const opened = await until(() => newWindows(before).some(w => w.rendered), 4000);
    await closeNewWindows(before);
    await closeMenu();
    await app.close({ animate: false });
    if ( opened ) done++;
  }
  return { done };
}

/** Leave a shop open, for the scenario where the world changes under it. */
export async function openAndHold({ traderId, actorId }) {
  return { open: !!(await openShop(traderId, actorId)) };
}

/** Close every shop on this client. */
export async function closeShops() {
  const { ShopApp } = await import(`${BASE}/app/shop-app.mjs`);
  let closed = 0;
  for ( const app of ShopApp.instances ) {
    await app.close({ animate: false });
    closed++;
  }
  return { closed };
}

/** How many shops are open and drawn on this client right now. */
export async function openShopCount() {
  const { ShopApp } = await import(`${BASE}/app/shop-app.mjs`);
  return ShopApp.instances.filter(app => app.rendered).length;
}

/* -------------------------------------------- */
/*  GM scenarios                                */
/* -------------------------------------------- */

/**
 * Change the Trader's shelf while shops are open elsewhere, as another player's purchase or a GM
 * edit would. Every change makes each open shop re-ask the GM and re-render.
 * @param {{traderId: string, cycles: number, gap?: number}} params
 *   `gap` outlasts the shop's refresh debounce, so each change is its own refresh.
 */
export async function worldChanges({ traderId, cycles, gap = 450 }) {
  const line = () => game.actors.get(traderId)?.items.find(item => item.name === `${PREFIX} Limited Stock`);
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    await line()?.update({ "system.quantity": 5 + (i % 5) });
    await wait(gap);
    done++;
  }
  await line()?.update({ "system.quantity": 10 });
  return { done };
}

/**
 * Change a world setting that reprices every shop, while shops are open elsewhere. Each change
 * makes every open shop on every client re-ask the GM (`ShopApp.refreshAll`).
 */
export async function settingChanges({ cycles, gap = 450 }) {
  const { PRICING_PRESETS } = await import(`${BASE}/config.mjs`);
  const presets = Object.keys(PRICING_PRESETS);
  const was = game.settings.get(MODULE, "pricingPreset");
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    await game.settings.set(MODULE, "pricingPreset", presets[i % presets.length]);
    await wait(gap);
    done++;
  }
  await game.settings.set(MODULE, "pricingPreset", was);
  return { done };
}

/**
 * The manager's bookkeeping, with the manager open to redraw around it: duplicate a Trader and
 * delete the copy, export one and import it back, save an archetype from it and delete that.
 */
export async function managerCrud({ traderId, cycles }) {
  const app = api().openManager();
  await until(() => app?.rendered);
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    try {
      const copy = await api().duplicateTrader(traderId);
      await copy.update({ name: `${NAME} Copy` });
      await wait(150);
      await api().deleteTrader(copy.id);

      const imported = await api().importTrader(JSON.stringify(api().exportTrader(traderId)));
      await imported.update({ name: `${NAME} Imported` });
      await wait(150);
      await api().deleteTrader(imported.id);

      const archetype = await api().saveArchetype(traderId, { name: `${NAME} Archetype ${i}` });
      await wait(150);
      await api().deleteArchetype(archetype.id ?? archetype);
      done++;
    } catch ( err ) {
      console.warn(`${PREFIX} memory: manager bookkeeping failed: ${err.message}`);
    }
  }
  await app?.close({ animate: false });
  return { done };
}

/** Open and close the Trader manager. */
export async function managerCycles({ cycles }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = api().openManager();
    await until(() => app?.rendered);
    const drawn = !!app?.rendered;
    await app?.close({ animate: false });
    if ( drawn ) done++;
    await wait(20);
  }
  return { done };
}

/**
 * Use the manager the way a GM does: pick the Trader, visit every tab, open and shut the generator,
 * open the magic item and scroll choosers, open a stock line's sheet.
 */
export async function managerUsed({ traderId, cycles }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const app = api().openManager();
    if ( !(await until(() => app?.rendered)) ) continue;
    const root = () => app.element;
    const click = async (selector, ms = 250) => {
      const target = root().querySelector(selector);
      target?.click();
      await wait(ms);
      return !!target;
    };

    await click(`[data-trader-id="${traderId}"] [data-action="selectTrader"]`);
    const tabs = [...root().querySelectorAll('[data-action="selectTab"]')].map(tab => tab.dataset.tab);
    for ( const tab of tabs ) await click(`[data-action="selectTab"][data-tab="${tab}"]`);
    await click('[data-action="selectTab"][data-tab="stock"]');

    await click('[data-action="toggleGenerator"]');
    await click('[data-action="toggleGenerator"]');

    // Each of these opens a window of its own: dnd5e's compendium browser as a picker (twice), the
    // magic item chooser, and a stock line's sheet. Each is closed unanswered, as a GM who changed
    // their mind would.
    const ACTIONS = ["addFromCompendium", "makeMagicItem", "makeScroll", "openStockItem"];
    let opened = 0;
    for ( const action of ACTIONS ) {
      const before = new Set(foundry.applications.instances.values());
      if ( !(await click(`[data-action="${action}"]`, 50)) ) continue;
      if ( await until(() => newWindows(before).some(w => w.rendered), 15_000) ) opened++;
      await wait(100);
      await closeNewWindows(before);
      await wait(100);
    }

    await app.close({ animate: false });
    if ( tabs.length && opened === ACTIONS.length && !app.rendered ) done++;
  }
  return { done };
}

/**
 * Stock the Trader from a built-in archetype, then clear what it made. This is the generator,
 * the enchanted-item synthesis and the scroll maker, end to end.
 */
export async function generateCycles({ traderId, cycles, archetypeId = "builtin-general" }) {
  const trader = () => game.actors.get(traderId);
  const fixture = new Set(trader().items.map(item => item.id));
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    try {
      await api().applyArchetype(traderId, archetypeId, { stock: true });
      const made = trader().items.filter(item => !fixture.has(item.id)).map(item => item.id);
      if ( made.length ) await trader().deleteEmbeddedDocuments("Item", made);
      if ( made.length ) done++;
    } catch ( err ) {
      console.warn(`${PREFIX} memory: generate cycle failed: ${err.message}`);
    }
  }
  return { done };
}

/** Post the Trader's chat card, which every client renders and wires, then delete it. */
export async function cardCycles({ traderId, cycles }) {
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    const message = await api().postTraderCard(traderId);
    await wait(250);
    if ( message ) {
      await message.delete();
      done++;
    }
  }
  return { done };
}

/** Show the Trader to every player. The players' clients open their shops; the runner closes them. */
export async function showOnce({ traderId }) {
  const shown = await api().showToPlayers(traderId);
  return { opened: shown?.opened?.length ?? 0 };
}

/**
 * Let world time run past a restock, over and over: the `updateWorldTime` hook, the claim and the
 * sweep. A line is sold down first each time so the sweep has something to put back.
 */
export async function restockCycles({ traderId, cycles }) {
  const trader = () => game.actors.get(traderId);
  const line = () => trader()?.items.find(item => item.name === `${PREFIX} Limited Stock`);
  await trader().setFlag(MODULE, "restock", { mode: "time", days: 1, lastAt: game.time.worldTime });
  let done = 0;
  for ( let i = 0; i < cycles; i++ ) {
    await line()?.update({ "system.quantity": 3 });
    await game.time.advance(86_400);
    if ( await until(() => line()?.system.quantity === 10, 3000) ) done++;
  }
  await trader().setFlag(MODULE, "restock", { mode: "manual", days: 7, lastAt: 0 });
  return { done };
}

/* -------------------------------------------- */
/*  The generator's caches (GM)                 */
/* -------------------------------------------- */

/** Drop the module's session caches, so their cost can be measured by filling them again. */
export async function dropCaches() {
  const { clearEnchantCaches } = await import(`${BASE}/data/enchant.mjs`);
  const { clearIndexCache } = await import(`${BASE}/data/item-index.mjs`);
  clearEnchantCaches();
  clearIndexCache();
  return true;
}

/**
 * Empty every compendium's document cache, as Foundry does by itself once a pack has gone five
 * minutes untouched (`CompendiumCollection.CACHE_LIFETIME_SECONDS`). Whatever is still in memory
 * afterwards is being held by someone other than Foundry.
 */
export async function flushPacks() {
  for ( const pack of game.packs ) pack.clear();
  return true;
}

/**
 * Build the generator's pool, as the first Generate does, and report what the template cache kept.
 *
 * `stray` is the invariant the cache fix is about: every document the cache holds must be a hollow
 * template. Anything else is a finished magic item pinned for the session for nothing.
 */
export async function buildPool() {
  const { stockPool } = await import(`${BASE}/data/trader.mjs`);
  const { templateCacheStats } = await import(`${BASE}/data/enchant.mjs`);
  const started = performance.now();
  const pool = await stockPool();
  const ms = Math.round(performance.now() - started);
  const kinds = {};
  for ( const entry of pool ) kinds[entry.kind ?? "item"] = (kinds[entry.kind ?? "item"] ?? 0) + 1;
  return { poolSize: pool.length, kinds, ms, ...templateCacheStats() };
}
