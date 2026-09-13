/*
 * This is the module's entry point — module.json points Foundry here via "esmodules".
 *
 * The file wires the module into Foundry's startup lifecycle using Hooks. A Hook is Foundry's
 * event system: `Hooks.once(event, fn)` runs `fn` a single time when that event fires,
 * `Hooks.on(event, fn)` runs it every time. The lifecycle order we use is:
 *
 *   init   -> register settings, templates and Handlebars helpers (before world data loads)
 *   ready  -> everything is loaded; safe to touch actors and post to chat
 *
 * We also listen for `getSceneControlButtons` to offer the GM a toolbar button.
 */

import {
  MODULE_ID, SETTINGS, DEFAULTS, DISPLAY_MODES, PRICING_PRESETS, HOOKS,
  ATTITUDE_MIN, ATTITUDE_MAX, fireHook, tpl, t, log, setting
} from "./config.mjs";
import { TraderManagerApp } from "./app/manager-app.mjs";
import { registerChatCard } from "./app/chat-card.mjs";
import { watchForeignWindows } from "./app/takeover.mjs";
import { ShopApp } from "./app/shop-app.mjs";
import { registerQueries } from "./trade/queries.mjs";
import { sweepRestocks } from "./data/trader.mjs";
import { registerApi } from "./api.mjs";
// Imported for its side effect: the file declares the shop-context query at module scope.
// Without this import nothing would ever register it, and a player's shop would find no
// handler on the GM's client.
import "./trade/context.mjs";
// Likewise: declares the trade query, which is the only path that moves goods or coin.
import "./trade/transaction.mjs";

/* -------------------------------------------- */
/*  Init: settings, templates, helpers          */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();
  registerHelpers();
  // The GM-side query handlers. Installed at `init` so a GM client is answering before any
  // player's `ready` can fire and open a shop from a card already in the log.
  registerQueries();
  registerChatCard();
  // Open shops re-ask the GM when either side of the counter changes, so nobody shops from a
  // shelf another player has already emptied.
  ShopApp.watchWorld();
  // Let item sheets and file pickers opened from inside a full-screen window actually be
  // visible, by lifting them above it. Registered at `init` so the watcher has seen every
  // render since the world loaded, which is how it tells an opening window from a
  // re-render — see app/takeover.mjs.
  watchForeignWindows();

  // Partials included by other templates must be registered up front: a partial is resolved
  // from the Handlebars registry at render time, not fetched on demand.
  //
  // Registered under short ids rather than their paths, so templates read `{{> shopTile}}`
  // instead of repeating the full `modules/<id>/templates/...` every time. `loadTemplates`
  // takes an id-to-path map for exactly this.
  //
  // Only partials included *by other templates* belong here. ApplicationV2 `PARTS` are fetched
  // by the framework and must not be listed, and a path that is not on disk logs a 404 to the
  // console even though the game carries on.
  foundry.applications.handlebars.loadTemplates({
    shopTile: tpl("shop/parts/tile.hbs"),
    shopAttitude: tpl("shop/parts/attitude-meter.hbs"),
    shopCoin: tpl("shop/parts/coin.hbs"),
    shopStagedRow: tpl("shop/parts/staged-row.hbs"),
    shopTraderCard: tpl("chat/trader-card.hbs"),
    shopReceipt: tpl("chat/receipt.hbs")
  });
});

/**
 * Declare every world setting so it appears in Foundry's "Configure Settings" and can be read
 * via `game.settings.get`. `scope: "world"` means one shared value for the whole game
 * (GM-controlled); `config: true` means it shows in the settings UI. Names and hints come from
 * lang/en.json through `t()` so they can be translated.
 */
function registerSettings() {
  // The Trader Manager is the only place Traders are created and stocked, so it gets a menu
  // button rather than being buried behind a setting.
  game.settings.registerMenu(MODULE_ID, "traderManager", {
    name: t("settings.traderManager.name"),
    label: t("settings.traderManager.label"),
    hint: t("settings.traderManager.hint"),
    icon: "fa-solid fa-shop",
    type: TraderManagerApp,
    restricted: true
  });

  /* --- Hidden state: the registry and its folder ------------------------- */

  // `config: false` — these are the module's own bookkeeping, written by the Trader Manager.
  // A GM editing them by hand could only break the registry, so they are not offered.
  game.settings.register(MODULE_ID, SETTINGS.traders, {
    scope: "world", config: false, type: Object, default: DEFAULTS.traders
  });
  game.settings.register(MODULE_ID, SETTINGS.traderFolder, {
    scope: "world", config: false, type: String, default: DEFAULTS.traderFolder
  });
  // The GM's saved archetypes. Written from the Trader Manager's Identity pane, never by hand.
  game.settings.register(MODULE_ID, SETTINGS.archetypes, {
    scope: "world", config: false, type: Object, default: DEFAULTS.archetypes
  });

  /* --- Pricing ----------------------------------------------------------- */

  game.settings.register(MODULE_ID, SETTINGS.pricingPreset, {
    name: t("settings.pricingPreset.name"),
    hint: t("settings.pricingPreset.hint"),
    scope: "world", config: true, type: String, default: DEFAULTS.pricingPreset,
    // No "custom" choice yet. The anchors setting and its validation exist, but there is no editor
    // for them, and a choice that silently behaves as Standard is worse than no choice. A world
    // that already stored "custom" keeps working: `pricingAnchors()` reads the stored set.
    choices: {
      fair: t("settings.pricingPreset.fair"),
      standard: t("settings.pricingPreset.standard"),
      harsh: t("settings.pricingPreset.harsh")
    }
  });
  // Meant to be edited through a pricing pane that can validate the arbitrage invariant and
  // explain a rejection; six raw number boxes in the flat settings list could not. Until that
  // pane exists it can only be set from the console with `game.settings.set`.
  game.settings.register(MODULE_ID, SETTINGS.pricingAnchors, {
    scope: "world", config: false, type: Object, default: DEFAULTS.pricingAnchors
  });

  /* --- Attitude ---------------------------------------------------------- */

  game.settings.register(MODULE_ID, SETTINGS.startingAttitude, {
    name: t("settings.startingAttitude.name"),
    hint: t("settings.startingAttitude.hint"),
    scope: "world", config: true, type: Number, default: DEFAULTS.startingAttitude,
    range: { min: ATTITUDE_MIN, max: ATTITUDE_MAX, step: 5 }
  });
  game.settings.register(MODULE_ID, SETTINGS.attitudeGainPerPoint, {
    name: t("settings.attitudeGainPerPoint.name"),
    hint: t("settings.attitudeGainPerPoint.hint"),
    scope: "world", config: true, type: Number, default: DEFAULTS.attitudeGainPerPoint
  });
  game.settings.register(MODULE_ID, SETTINGS.attitudeGainCap, {
    name: t("settings.attitudeGainCap.name"),
    hint: t("settings.attitudeGainCap.hint"),
    scope: "world", config: true, type: Number, default: DEFAULTS.attitudeGainCap,
    range: { min: 0, max: 25, step: 1 }
  });

  /* --- Presentation ------------------------------------------------------ */

  game.settings.register(MODULE_ID, SETTINGS.displayMode, {
    name: t("settings.displayMode.name"),
    hint: t("settings.displayMode.hint"),
    scope: "world", config: true, type: String, default: DEFAULTS.displayMode,
    choices: Object.fromEntries(DISPLAY_MODES.map(m => [m, t(`settings.displayMode.${m}`)]))
  });
  game.settings.register(MODULE_ID, SETTINGS.sceneButton, {
    name: t("settings.sceneButton.name"),
    hint: t("settings.sceneButton.hint"),
    scope: "world", config: true, type: Boolean, default: DEFAULTS.sceneButton,
    // Foundry prepares the scene controls *once* and reuses the structure on later renders, so
    // toggling this has no effect until the controls are rebuilt. `reset: true` is what forces
    // that, and without it the setting looks broken until the next reload.
    onChange: () => ui.controls?.render({ reset: true })
  });

  game.settings.register(MODULE_ID, SETTINGS.debug, {
    name: t("settings.debug.name"),
    hint: t("settings.debug.hint"),
    scope: "world", config: true, type: Boolean, default: DEFAULTS.debug
  });
}

/**
 * Handlebars helpers the templates need.
 *
 * `shopItemTooltip` emits the `data-tooltip` payload that triggers a dnd5e *rich* item tooltip.
 * The system's global observer watches the live tooltip element for a `.loading[data-uuid]`
 * section and swaps it for the item's own `richTooltip()` on hover. A bare " " can never become
 * one — it shows an empty black box — so item links must emit this instead. Handlebars escapes
 * the returned string into the attribute and the browser decodes it back to real HTML, so
 * `element.dataset.tooltip` yields exactly the markup dnd5e looks for.
 */
function registerHelpers() {
  Handlebars.registerHelper("shopItemTooltip", uuid => {
    if ( !uuid ) return "";
    return `<section class="loading" data-uuid="${uuid}"><i class="fa-solid fa-spinner fa-spin-pulse"></i></section>`;
  });
}

/* -------------------------------------------- */
/*  Scene controls                              */
/* -------------------------------------------- */

/**
 * Offer the GM a shop button in the scene-controls toolbar, when the world has asked for one.
 *
 * In v13+ the hook receives a *record* of control sets rather than an array, and each set's
 * `tools` is likewise a record keyed by tool name. `button: true` means the tool resolves
 * immediately on click instead of becoming the active tool.
 */
Hooks.on("getSceneControlButtons", controls => {
  if ( !game.user.isGM || !setting(SETTINGS.sceneButton) ) return;
  const tokens = controls.tokens;
  if ( !tokens?.tools ) return;
  tokens.tools[`${MODULE_ID}-manager`] = {
    name: `${MODULE_ID}-manager`,
    title: t("sceneControl.title"),
    icon: "fa-solid fa-shop",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => TraderManagerApp.launch()
  };
});

/* -------------------------------------------- */
/*  Ready                                       */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  log(`ready — ${Object.keys(PRICING_PRESETS).length} pricing presets, `
    + `"${setting(SETTINGS.pricingPreset)}" in force`);

  // Time-based restocking, on **one** client only. Every client sees `updateWorldTime`, and a
  // table with two GMs would otherwise sweep twice on the same tick: the writes are idempotent,
  // but the `restocked` hook firing twice is not, and nor is a doubled announcement.
  // `activeGM` designates exactly one, deterministically.
  Hooks.on("updateWorldTime", worldTime => {
    if ( game.users.activeGM?.id !== game.user.id ) return;
    sweepRestocks(worldTime).catch(err => log("restock sweep failed", err));
  });

  const api = registerApi();
  fireHook(HOOKS.ready, { api, version: game.modules.get(MODULE_ID)?.version ?? "" });
});
