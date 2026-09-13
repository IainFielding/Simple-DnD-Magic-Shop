/**
 * The assertions that need two clients in the same world at once.
 *
 * Everything in `harness.mjs` could in principle run on one client. These cannot. A player's
 * browser genuinely cannot see a Trader actor, and the only way to *prove* that is to ask a
 * player's browser — from the GM's client it is unfalsifiable, because the GM can see
 * everything.
 *
 * Half of this file therefore runs as the GM (setting up) and half as a player (looking), and
 * `run.mjs` calls each half on the right session.
 */

const PREFIX = "[e2e]";
const MODULE = "sogrom-simple-dnd5e-magic-shop";
const BASE = `/modules/${MODULE}/scripts`;

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

/**
 * Create a Trader for the player clients to look at. Runs as the GM.
 *
 * Ownership is left at the default — **no player rights at all** — which is the configuration
 * under test. If a future change accidentally granted players observer rights on Traders, the
 * player-side assertions below would start failing, which is exactly what should happen.
 * @returns {Promise<string>}  The Trader's id.
 */
export async function makeSharedTrader() {
  const { createTrader } = await import(`${BASE}/data/registry.mjs`);
  const name = `${PREFIX} Shared`;

  const existing = game.actors.find(a => a.name === name);
  if ( existing ) await existing.delete();

  const trader = await createTrader({ name, greeting: "Look, do not touch." });
  await trader.update({ "system.currency": { pp: 0, gp: 300, ep: 0, sp: 0, cp: 0 } });

  await trader.createEmbeddedDocuments("Item", [
    {
      name: `${PREFIX} Open Stock`,
      type: "loot",
      img: "icons/svg/item-bag.svg",
      system: { quantity: 2, price: { value: 10, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 2 } }
    },
    {
      name: `${PREFIX} Gated Stock`,
      type: "loot",
      img: "icons/svg/mystery-man.svg",
      system: { quantity: 1, price: { value: 999, denomination: "gp" } },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: 95, baseQty: 1 } }
    }
  ]);

  return trader.id;
}

/**
 * Change the shared Trader's open stock, as another player's purchase or a GM restock would.
 * Runs as the GM.
 * @param {{traderId: string, qty: number}} params
 */
export async function setOpenStock({ traderId, qty }) {
  const trader = game.actors.get(traderId);
  const line = trader?.items.find(i => i.name.includes("Open Stock"));
  await line?.update({ "system.quantity": qty });
  return !!line;
}

/** Tidy up after the cross-client checks. Runs as the GM. */
export async function cleanupSharedTrader({ traderId }) {
  const trader = game.actors.get(traderId);
  if ( trader ) await trader.delete();
  return true;
}

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/**
 * Look at the Trader as a player, and report what is and is not reachable.
 *
 * Returns a flat object of findings rather than asserting here, so the failure messages live in
 * the runner where they can be printed properly.
 *
 * @param {{traderId: string, module: string}} params
 * @returns {Promise<object>}
 */
export async function inspectAsPlayer({ traderId }) {
  const findings = {
    cannotOpenSheet: null,
    cannotWrite: null,
    replicatedItemCount: 0,
    contextOk: false,
    firstPrice: 0,
    sawGated: null,
    forgedRefused: null,
    forgedDetail: "",
    error: null
  };

  const { QUERIES, askGM } = await import(`${BASE}/trade/queries.mjs`);

  // 1. What a player's own client can do with the Trader.
  //
  // Note what is *not* asserted here. Foundry replicates full Actor documents — embedded items
  // included — to every connected client; ownership gates sheet access and writes, not data
  // transmission. So `game.actors.get(id).items` is populated on a player's client no matter
  // what, and `replicatedItemCount` records that fact rather than failing on it. See the
  // confidentiality note in docs/PLAN.md §6.
  //
  // What the permission model does give us is integrity, and that is what these two check.
  const local = game.actors.get(traderId);
  findings.replicatedItemCount = local?.items?.size ?? 0;
  findings.cannotOpenSheet = !local?.testUserPermission(game.user, "OBSERVER");

  try {
    await local.update({ "system.currency.gp": 999_999 });
    findings.cannotWrite = false;
  } catch {
    findings.cannotWrite = true;
  }

  // 2. What it can get through the GM.
  try {
    const payload = await askGM(QUERIES.context, {
      traderId,
      actorId: game.user.character?.id
    });
    findings.contextOk = true;
    findings.firstPrice = payload.stock?.[0]?.buyCp ?? 0;
    findings.sawGated = (payload.stock ?? []).some(line => line.name.includes("Gated Stock"));
  } catch ( err ) {
    findings.error = err.message;
  }

  // 3. The forgery. Asking for someone else's character must be refused by the GM, not by this
  //    client — which is why it goes over the socket rather than through a local check.
  const someoneElse = game.actors.find(a =>
    a.type === "character" && a.id !== game.user.character?.id && a.name.startsWith(PREFIX));

  if ( !someoneElse ) {
    findings.forgedRefused = null;
    findings.forgedDetail = "no second character to impersonate";
  } else {
    try {
      await askGM(QUERIES.context, { traderId, actorId: someoneElse.id });
      findings.forgedRefused = false;
      findings.forgedDetail = `was allowed to shop as "${someoneElse.name}"`;
    } catch ( err ) {
      findings.forgedRefused = true;
      findings.forgedDetail = err.message;
    }
  }

  return findings;
}

/**
 * Open the shared Trader's shop in this player's own window. Runs as a player.
 * @param {{traderId: string}} params
 * @returns {Promise<{open: boolean, badge: string|null}>}
 */
export async function openShopAsPlayer({ traderId }) {
  const app = await game.modules.get(MODULE).api.openShop(traderId);
  await new Promise(resolve => setTimeout(resolve, 300));
  return { open: !!app?.rendered, badge: openStockBadge(app) };
}

/**
 * What this player's open shop shows for the open stock line, after giving a change time to
 * arrive. Runs as a player. A missing tile means the line is not on the shelf at all.
 * @param {{waitMs?: number}} [params]
 */
export async function readShopAsPlayer({ waitMs = 1200 } = {}) {
  await new Promise(resolve => setTimeout(resolve, waitMs));
  const { ShopApp } = await import(`${BASE}/app/shop-app.mjs`);
  const app = ShopApp.instances.find(a => a.element?.isConnected);
  return { open: !!app, badge: openStockBadge(app), tile: !!openStockTile(app) };
}

/** Close this player's shop windows. Runs as a player. */
export async function closeShopsAsPlayer() {
  const { ShopApp } = await import(`${BASE}/app/shop-app.mjs`);
  for ( const app of ShopApp.instances ) await app.close();
  return true;
}

function openStockTile(app) {
  return [...(app?.element?.querySelectorAll(".shop-panel--stock .shop-tile") ?? [])]
    .find(tile => tile.dataset.name?.includes("Open Stock")) ?? null;
}

function openStockBadge(app) {
  return openStockTile(app)?.querySelector(".shop-tile-badge")?.textContent.trim() ?? null;
}
