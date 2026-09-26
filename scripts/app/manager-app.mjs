import {
  MODULE_ID, PHYSICAL_TYPES, PRICING_PRESETS, SETTINGS, itemRarity, maxStockLines, setting, tpl, t, log
} from "../config.mjs";
import { attitudeTier } from "../data/attitude.mjs";
import { RESTOCK_MODES, daysUntilRestock } from "../data/restock.mjs";
import {
  BUDGET_KEYS, budgetTotal, categoryCounts, defaultBudget, filterPool,
  rollTableStock, sanitizeBudget
} from "../data/generate.mjs";
import { poolCounts, poolSources } from "../data/item-index.mjs";
import { formatCp, itemValueCp, priceMultipliers, pricesFor, totalCp } from "../data/pricing.mjs";
import {
  createTrader, deleteTrader, duplicateTrader, getTrader, importTrader, listTraders, pruneRegistry
} from "../data/registry.mjs";
import {
  FILTER_RARITIES, MUNDANE, cpToPriceParts, effectiveValueCp, parsePriceInput, stockRoom
} from "../data/stock.mjs";
import { droppedFolderItems, sortDropped } from "../data/folder-drop.mjs";
import {
  addMadeStock, addStockItems, applyArchetype, clearLedger, gainSettings, getAttitude, ledgerOf, purse,
  restockTrader, setAttitude, spendFor, stockEntries, stockFromRecipe, stockLimit, stockLine, stockPool,
  traderData
} from "../data/trader.mjs";
import {
  enchantmentValueCp, isMakeable, makeEnchantedData, makeScrollData, templateCatalogue,
  templateChoices
} from "../data/enchant.mjs";
import { itemPool } from "../data/item-index.mjs";
import {
  BUILT_IN_ARCHETYPES, archetypeFromTrader, budgetSummary, deleteArchetype, listArchetypes,
  recipeToGenerator, saveArchetype
} from "../data/archetypes.mjs";
import { LEDGER_LIMIT, ledgerCharacters, ledgerTotals } from "../data/ledger.mjs";
import { exportFileName, exportTrader } from "../data/portable.mjs";
import { historyView } from "../trade/context.mjs";
import { categoryLabel, categoryTree } from "./categories.mjs";
import { ShopShellBase } from "./shell-base.mjs";
import { yieldTakeoverTo } from "./takeover.mjs";
import { ShopApp } from "./shop-app.mjs";
import { postTraderCard } from "./chat-card.mjs";
import { showToPlayers } from "./show.mjs";

/**
 * The GM-facing Trader Manager: the one and only place Traders are created, stocked and
 * configured. Opened from the module's settings menu or the scene-controls button.
 *
 * A rail of Traders down the left, the selected Trader's panes beside it.
 *
 * ## Why there is no Save button
 *
 * The plan originally called for a working copy committed by Save, modelled on the sister
 * module's store-config window. That was the right shape *there*, because its inventory is a
 * single world setting — one object, written atomically. Ours is not: stock is the Trader
 * actor's embedded Items, and identity is flags on the actor. A working copy over embedded
 * documents would mean reimplementing create/update/delete diffing, and a GM who spent twenty
 * minutes stocking a shop could lose all of it to a stray Escape.
 *
 * So this behaves like every other Foundry sheet: edits commit on `change` (blur or Enter, not
 * per keystroke), drops create the item immediately, and removal deletes it. That is also what
 * makes two GMs with the manager open merely awkward rather than destructive.
 *
 * ## The five panes
 *
 * Identity is who the Trader is (and the archetype it can start from); Stock is what it sells;
 * Trading is how it bargains and when it restocks; Attitudes is what it thinks of each character;
 * Ledger is every deal it has struck. Only the selected pane's context is built, because the Stock
 * pane's price previews, the Attitudes table and the Ledger are all per-row work nobody is looking
 * at from the other tabs.
 */
export class TraderManagerApp extends ShopShellBase {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-manager`,
    window: {
      title: `${MODULE_ID}.manager.title`,
      icon: "fa-solid fa-shop"
    },
    actions: {
      createTrader: TraderManagerApp.#onCreateTrader,
      duplicateTrader: TraderManagerApp.#onDuplicateTrader,
      deleteTrader: TraderManagerApp.#onDeleteTrader,
      selectTrader: TraderManagerApp.#onSelectTrader,
      selectTab: TraderManagerApp.#onSelectTab,
      pickPortrait: TraderManagerApp.#onPickPortrait,
      removeStock: TraderManagerApp.#onRemoveStock,
      openStockItem: TraderManagerApp.#onOpenStockItem,
      addFromCompendium: TraderManagerApp.#onAddFromCompendium,
      makeMagicItem: TraderManagerApp.#onMakeMagicItem,
      makeScroll: TraderManagerApp.#onMakeScroll,
      toggleGenerator: TraderManagerApp.#onToggleGenerator,
      generateStock: TraderManagerApp.#onGenerateStock,
      drawFromTable: TraderManagerApp.#onDrawFromTable,
      clearStock: TraderManagerApp.#onClearStock,
      postCard: TraderManagerApp.#onPostCard,
      showToPlayers: TraderManagerApp.#onShowToPlayers,
      openShopAsGM: TraderManagerApp.#onOpenShopAsGM,
      restockNow: TraderManagerApp.#onRestockNow,
      resetAttitude: TraderManagerApp.#onResetAttitude,
      clearCategories: TraderManagerApp.#onClearCategories,
      applyArchetype: TraderManagerApp.#onApplyArchetype,
      applyArchetypeStock: TraderManagerApp.#onApplyArchetypeStock,
      saveArchetype: TraderManagerApp.#onSaveArchetype,
      deleteArchetype: TraderManagerApp.#onDeleteArchetype,
      exportTrader: TraderManagerApp.#onExportTrader,
      importTrader: TraderManagerApp.#onImportTrader,
      clearLedger: TraderManagerApp.#onClearLedger
    }
  };

  /**
   * Three parts, so the rail can be redrawn without the icon-heavy stock table and vice versa.
   * Each part renders exactly one root element; the grid that arranges them is on the window's
   * own element (see the `:has(.shop-rail)` rules in shop.css).
   * @override
   */
  static PARTS = {
    topbar: { template: tpl("manager/topbar.hbs") },
    rail: { template: tpl("manager/rail.hbs"), scrollable: [""] },
    pane: { template: tpl("manager/pane.hbs"), scrollable: [""] }
  };

  /** The panes, in tab order. */
  static TABS = [
    { id: "identity", icon: "fa-solid fa-user-tie", ready: true },
    { id: "stock", icon: "fa-solid fa-boxes-stacked", ready: true },
    { id: "trading", icon: "fa-solid fa-scale-balanced", ready: true },
    { id: "attitudes", icon: "fa-solid fa-face-smile", ready: true },
    { id: "ledger", icon: "fa-solid fa-book", ready: true }
  ];

  /** Id of the Trader on screen, or null for the empty state. */
  #selected = null;

  /** Which pane is showing. */
  #tab = "identity";

  /** Whether the drag-and-drop listeners are attached; the root element persists. */
  #dndWired = false;

  /**
   * The generator panel's own state, held on the instance so it survives the re-render that
   * follows each generation run. Collapsed by default, and the item pool is only built once it
   * is opened — walking every compendium takes a noticeable moment and most visits to the Stock
   * tab are to edit a row, not to generate.
   */
  #generator = {
    open: false,
    budget: defaultBudget(),
    maxValue: "",
    maxDenom: "gp",
    packs: [],
    categories: [],
    tableId: "",
    draws: 5
  };

  /** The archetype chosen in the Identity pane's picker. Window state, never persisted. */
  #archetypeId = BUILT_IN_ARCHETYPES[0].id;

  /** The Ledger pane's character filter: an actor id, or "" for everyone. */
  #ledgerActor = "";

  /* -------------------------------------------- */
  /*  Launching                                   */
  /* -------------------------------------------- */

  /**
   * Open the manager, bringing an existing window forward rather than opening a second.
   *
   * Two entry points reach this (the settings menu and the toolbar button) and a GM can click
   * either while the other's window is up. Two copies of a live-editing window over the same
   * documents is a race nobody needs.
   * @returns {TraderManagerApp}
   */
  static launch() {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-manager`);
    if ( existing ) {
      existing.bringToFront?.();
      return existing;
    }
    const app = new this();
    app.render({ force: true });
    return app;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const traders = listTraders();

    // A Trader deleted from the sidebar while the manager was open leaves a stale selection.
    if ( this.#selected && !traders.some(a => a.id === this.#selected) ) this.#selected = null;
    if ( !this.#selected && traders.length ) this.#selected = traders[0].id;

    const trader = this.#selected ? getTrader(this.#selected) : null;

    return Object.assign(context, {
      traders: traders.map(actor => this.#railEntry(actor)),
      hasTraders: traders.length > 0,
      trader: trader ? this.#traderContext(trader) : null,
      // The selected pane's own view model, spread at the **top level** beside `trader` rather
      // than inside it.
      //
      // This was the shape of three separate bugs. `#traderContext`'s return value *becomes*
      // `context.trader`, so anything merged into it landed at `trader.rows`, `trader.buyFilter`,
      // `trader.attitudes` — while the templates read `rows`, `buyFilter`, `attitudes`. Handlebars
      // resolves a missing key to undefined in silence, so every one of them rendered its
      // surrounding markup perfectly and filled it with nothing.
      //
      // Splitting them apart removes the ambiguity: `trader` is who the Trader *is*, and
      // everything else on the context is what this pane needs to draw. A view model is not a
      // property of the Trader and should never have been living inside one.
      ...(trader ? await this.#paneContext(trader) : {}),
      tabs: this.constructor.TABS.map(tab => ({
        ...tab,
        label: t(`manager.tab.${tab.id}`),
        active: tab.id === this.#tab
      })),
      tab: this.#tab
    });
  }

  /** One rail row: enough to identify a Trader at a glance without loading its stock. */
  #railEntry(actor) {
    const entries = stockEntries(actor);
    return {
      id: actor.id,
      name: actor.name,
      img: actor.img,
      active: actor.id === this.#selected,
      stockCount: entries.length,
      // Null for a Trader with no limit, which the template reads as "just say how many".
      maxLines: Number.isFinite(stockLimit(actor)) ? stockLimit(actor) : null,
      purse: formatCp(this.#purseCp(actor))
    };
  }

  /** A Trader's own purse in copper, for the rail and the identity pane. */
  #purseCp(actor) {
    return totalCp(purse(actor));
  }

  /**
   * Who the Trader is: the fields every pane's header and the rail need.
   *
   * Identity only. Whatever the *selected pane* needs to draw belongs in {@link #paneContext},
   * at the top level of the render context — see the note there.
   */
  #traderContext(actor) {
    const data = traderData(actor);
    const base = {
      id: actor.id,
      name: actor.name,
      img: actor.img,
      greeting: data.greeting,
      startingAttitude: data.startingAttitude,
      currency: Object.entries(CONFIG.DND5E.currencies).map(([key, config]) => ({
        key,
        label: config.abbreviation ?? key,
        value: purse(actor)[key] ?? 0
      })),
      purse: formatCp(this.#purseCp(actor))
    };
    return base;
  }

  /**
   * Everything the selected pane needs, and nothing the others do.
   *
   * Built per pane rather than all at once because each is real work nobody is looking at from
   * the other tabs: the stock pane prices every row, the attitudes pane prices every character,
   * and the generator walks every compendium in the world.
   * @param {object} actor
   * @returns {Promise<object>}
   */
  async #paneContext(actor) {
    const data = traderData(actor);
    switch ( this.#tab ) {
      case "identity":
        return { archetypes: this.#archetypeContext() };
      case "ledger":
        return { ledger: this.#ledgerContext(actor) };
      case "stock":
        return {
          ...this.#stockContext(actor),
          generator: await this.#generatorContext()
        };
      case "trading":
        return this.#tradingContext(actor, data);
      case "attitudes":
        return this.#attitudesContext(actor, data);
      default:
        return {};
    }
  }

  /**
   * The Trading pane: what the Trader will buy, when it restocks, and how fast it warms to a
   * paying customer.
   */
  #tradingContext(actor, data) {
    const filter = data.buyFilter;
    const restock = data.restock;
    const gain = data.attitudeGain;

    return {
      buyFilter: {
        allowAll: filter.allowAll,
        types: PHYSICAL_TYPES.map(type => ({
          value: type,
          label: game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type),
          checked: filter.types.includes(type)
        })),
        rarities: FILTER_RARITIES.map(key => ({
          value: key,
          label: t(`rarity.${key === MUNDANE ? "mundane" : key}`),
          checked: filter.rarities.includes(key)
        }))
      },
      restock: {
        mode: restock.mode,
        modes: RESTOCK_MODES.map(mode => ({
          value: mode,
          label: t(`manager.trading.restock.${mode}`),
          selected: mode === restock.mode
        })),
        days: restock.days,
        timed: restock.mode === "time",
        // Null for a Trader that never restocks on its own, which the template reads as
        // "nothing to count down to".
        due: daysUntilRestock(restock, game.time.worldTime)
      },
      gain: {
        // An unset override means "follow the world", and that has to stay distinguishable from
        // "0 copper per point", which means the drift is off for this Trader specifically.
        custom: !!gain,
        cpPerPoint: (gain ?? gainSettings(actor)).cpPerPoint,
        capPerVisit: (gain ?? gainSettings(actor)).capPerVisit,
        worldPerPoint: setting(SETTINGS.attitudeGainPerPoint),
        worldCap: setting(SETTINGS.attitudeGainCap)
      },
      shelves: {
        allUnlimited: data.allUnlimited,
        noStockLimit: data.noStockLimit,
        worldLimit: maxStockLines(),
        // Lifting the limit and then putting it back leaves a Trader holding more than the world
        // allows. It keeps them, but takes nothing new until it is under, and the GM should know.
        over: Math.max(0, stockEntries(actor).length - maxStockLines())
      }
    };
  }

  /**
   * The Attitudes pane: one row per character this Trader has an opinion about.
   *
   * Lists every *player* character in the world, not only the ones with a stored attitude —
   * a GM wanting to warm a Trader to the party should not have to make them shop first to get
   * a row to edit.
   */
  #attitudesContext(actor, data) {
    const characters = game.actors
      .filter(a => a.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    return {
      attitudes: characters.map(character => {
        const value = getAttitude(actor, character);
        const spend = spendFor(actor, character);
        return {
          id: character.id,
          name: character.name,
          img: character.img,
          value,
          tier: attitudeTier(value).label,
          // "Met" means there is a stored opinion; everyone else is sitting on the default.
          met: data.attitude[character.id] !== undefined,
          chaMod: character.system?.abilities?.cha?.mod ?? 0,
          spent: formatCp(spend.lifetimeCp),
          multipliers: (() => {
            const m = priceMultipliers({
              chaMod: character.system?.abilities?.cha?.mod ?? 0, attitude: value
            });
            return { buy: m.buy.toFixed(2), sell: m.sell.toFixed(2) };
          })()
        };
      }),
      hasCharacters: characters.length > 0
    };
  }

  /**
   * The Identity pane's archetype picker: every archetype as an option, and the chosen one spelled
   * out — what it stocks, what it buys, how it restocks — so a GM can read what Apply will do
   * before pressing it.
   */
  #archetypeContext() {
    const all = listArchetypes();
    const chosen = all.find(a => a.id === this.#archetypeId) ?? all[0];
    this.#archetypeId = chosen.id;

    const option = a => ({ id: a.id, name: archetypeName(a), selected: a.id === chosen.id });
    const f = chosen.buyFilter;
    const buys = f.allowAll
      ? t("manager.archetype.buysAnything")
      : [
        ...f.types.map(type => game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type)),
        ...f.rarities.map(key => t(`rarity.${key === MUNDANE ? "mundane" : key}`))
      ].join(", ") || t("manager.archetype.buysAnything");

    return {
      builtIn: all.filter(a => a.builtIn).map(option),
      saved: all.filter(a => !a.builtIn).map(option),
      hasSaved: all.some(a => !a.builtIn),
      chosen: {
        id: chosen.id,
        name: archetypeName(chosen),
        hint: chosen.builtIn ? game.i18n.localize(chosen.hint) : "",
        icon: chosen.icon,
        builtIn: chosen.builtIn,
        stocks: budgetSummary(chosen.recipe)
          .map(([key, n]) => `${n} ${key ? t(`rarity.${key}`) : t("rarity.mundane")}`)
          .join(", "),
        kinds: chosen.recipe.categories.map(categoryLabel).join(", ")
          || t("manager.archetype.anyKind"),
        ceiling: chosen.recipe.maxValueCp > 0 ? formatCp(chosen.recipe.maxValueCp) : "",
        buys,
        restock: chosen.restock.mode === "time"
          ? t("manager.archetype.restockEvery", { days: chosen.restock.days })
          : t(`manager.trading.restock.${chosen.restock.mode}`),
        attitude: chosen.startingAttitude === null
          ? t("manager.archetype.attitudeUnchanged")
          : String(chosen.startingAttitude)
      }
    };
  }

  /**
   * The Ledger pane: every deal this Trader has struck, newest first, optionally narrowed to one
   * character, with what it all came to.
   */
  #ledgerContext(actor) {
    const all = ledgerOf(actor);
    const characters = ledgerCharacters(all);
    // A filter for a character whose rows were all cleared would show an empty table under a
    // filter that no longer offers itself; drop it.
    if ( this.#ledgerActor && !characters.some(c => c.id === this.#ledgerActor) ) this.#ledgerActor = "";
    const entries = this.#ledgerActor ? all.filter(e => e.actorId === this.#ledgerActor) : all;
    const totals = ledgerTotals(entries);

    return {
      rows: entries.map(entry => ({
        ...historyView(entry),
        actorName: entry.actorName,
        userName: entry.userName
      })),
      hasRows: entries.length > 0,
      hasAny: all.length > 0,
      filter: [
        { id: "", name: t("manager.ledger.everyone"), selected: !this.#ledgerActor },
        ...characters.map(c => ({ ...c, selected: c.id === this.#ledgerActor }))
      ],
      totals: {
        trades: totals.trades,
        taken: formatCp(totals.takenCp),
        paid: formatCp(totals.paidCp),
        itemsSold: totals.itemsSold,
        itemsBought: totals.itemsBought
      },
      limit: LEDGER_LIMIT
    };
  }

  /**
   * The generator panel's state as a stock recipe — what Generate runs, and what "Save as
   * archetype" records.
   * @returns {import("../data/archetypes.mjs").Recipe}
   */
  #recipe() {
    const state = this.#generator;
    return {
      budget: state.budget,
      categories: state.categories,
      packs: state.packs,
      maxValueCp: parsePriceInput(state.maxValue, state.maxDenom) ?? 0
    };
  }

  /**
   * The kinds of item the generator may draw from, as a two-level tree with counts.
   *
   * Built from the system's own config maps rather than a list of our own, so it picks up
   * whatever a content module adds and is localised by dnd5e. The tree itself lives in
   * `app/categories.mjs`, shared with the shop's item type filter, so the categories a GM builds
   * a shop from are the ones a player filters its shelves by.
   *
   * A type with nothing in the pool is dropped entirely, and a subtype with nothing is dropped
   * from its group: a list of forty tickable things that would generate nothing is worse than a
   * short list of things that work.
   * @param {import("../data/generate.mjs").PoolEntry[]} pool  Already narrowed by pack and price.
   * @returns {object[]}
   */
  #categoryTree(pool) {
    return categoryTree(categoryCounts(pool), new Set(this.#generator.categories));
  }

  /**
   * The generator panel.
   *
   * Only builds the item pool when the panel is open, and reports what the pool actually holds
   * at each rarity beside each input — so a GM asking for three artifacts can see that their
   * enabled packs contain one, rather than generating and wondering.
   */
  async #generatorContext() {
    const state = this.#generator;
    if ( !state.open ) return { open: false };

    // The generator's own pool, with DMG templates and blank scrolls swapped for what can really
    // be made from them, so the counts beside each rarity are counts of things a run can produce.
    const pool = await stockPool();
    const narrowing = {
      packs: state.packs,
      maxValueCp: parsePriceInput(state.maxValue, state.maxDenom) ?? 0
    };
    // The rarity counts respect the *whole* narrowing including the chosen kinds, so they say
    // what a run would actually find. The category tree deliberately does not: its own counts
    // are what tell a GM what ticking something would get them, and they would all read zero the
    // moment anything was ticked.
    const filtered = filterPool(pool, { ...narrowing, categories: state.categories });
    const counts = poolCounts(filtered);

    return {
      open: true,
      buckets: BUDGET_KEYS.map(key => ({
        key,
        // Our own labels rather than `CONFIG.DND5E.itemRarity`, which is keyed on the system's
        // camelCase form ("veryRare") while everything here uses the normalised one
        // ("veryrare"). Mapping between them buys nothing but a mapping to keep in step.
        label: key ? t(`rarity.${key}`) : t("rarity.mundane"),
        value: state.budget[key] ?? 0,
        available: counts[key] ?? 0
      })),
      maxValue: state.maxValue,
      maxDenom: state.maxDenom,
      denominations: Object.keys(CONFIG.DND5E.currencies).map(d => ({
        value: d, label: d, selected: d === state.maxDenom
      })),
      sources: poolSources(pool).map(source => ({
        ...source,
        checked: state.packs.includes(source.id)
      })),
      categories: this.#categoryTree(filterPool(pool, narrowing)),
      anyCategory: state.categories.length === 0,
      poolSize: filtered.length,
      total: budgetTotal(state.budget),
      tables: game.tables.contents
        .map(table => ({ id: table.id, name: table.name, selected: table.id === state.tableId }))
        .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)),
      hasTables: game.tables.size > 0,
      tableId: state.tableId,
      draws: state.draws
    };
  }

  /**
   * The stock table.
   *
   * Prices preview at Charisma +0 / attitude 50 — a stranger with no gift for it — because that
   * is the one reference point every GM can reason from. Showing the GM their own character's
   * price would be meaningless, and showing the raw list value would hide the markup the world's
   * pricing preset applies.
   */
  #stockContext(actor) {
    const multipliers = priceMultipliers({ chaMod: 0, attitude: 50 });
    const { allUnlimited } = traderData(actor);
    const limit = stockLimit(actor);
    const denominations = Object.keys(CONFIG.DND5E.currencies);

    const rows = stockEntries(actor).map(({ id, item, line }) => {
      const valueCp = effectiveValueCp(item, line);
      const { buyCp, sellCp } = pricesFor(valueCp, multipliers);
      const override = line.overrideCp === null ? null : cpToPriceParts(line.overrideCp);
      return {
        id,
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        type: item.type,
        rarity: itemRarity(item),
        quantity: item.system?.quantity ?? 0,
        unlimited: line.unlimited,
        // The row's own toggle means nothing while the Trader makes everything unlimited, so it is
        // shown ticked and locked rather than inviting a click that would change nothing.
        unlimitedLocked: allUnlimited,
        baseQty: line.baseQty,
        revealAt: line.revealAt,
        // An item with no price of its own and no override cannot be sold; the row says so
        // rather than quietly showing "0 cp" and leaving the GM to wonder.
        unpriced: valueCp <= 0,
        overrideValue: override?.value ?? "",
        overrideDenom: override?.denomination ?? "gp",
        denominations: denominations.map(d => ({
          value: d, label: d, selected: d === (override?.denomination ?? "gp")
        })),
        previewBuy: valueCp > 0 ? formatCp(buyCp) : "—",
        previewSell: valueCp > 0 ? formatCp(sellCp) : "—",
        // Raw copper alongside the formatted strings, so the render suite can compare the two
        // figures without parsing "1,650 gp 5 sp" back into a number.
        previewBuyCp: buyCp,
        previewSellCp: sellCp
      };
    });

    return {
      rows,
      hasRows: rows.length > 0,
      lineCount: rows.length,
      maxLines: Number.isFinite(limit) ? limit : null,
      isFull: rows.length >= limit,
      // Worded from the Trader's side, matching the column: it buys at the character's sell
      // multiplier and sells at their buy multiplier.
      previewNote: t("manager.stock.previewNote", {
        buys: (multipliers.sell).toFixed(2),
        sells: (multipliers.buy).toFixed(2)
      })
    };
  }

  /* -------------------------------------------- */
  /*  Stock sources                               */
  /* -------------------------------------------- */

  /**
   * Add stock through the system's own compendium browser.
   *
   * `CompendiumBrowser.select` already has search, type tabs, rarity and price filters, source
   * settings and multi-select. A hand-rolled picker could only ever be a worse version of a
   * window dnd5e already ships, so this opens theirs, locked to physical item types.
   */
  static async #onAddFromCompendium() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;

    const browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
    if ( !browser?.select ) return void ui.notifications.warn(t("manager.generate.noBrowser"));

    const selected = await browser.select({
      // `locked` filters are fixed rather than offered: a Trader cannot stock a spell, so
      // letting the GM switch to the spell tab would only invite a dead end.
      filters: { locked: { documentClass: "Item", types: new Set(PHYSICAL_TYPES) } },
      selection: { min: 0, max: null }
    });
    if ( !selected?.size ) return;

    // The browser is a Foundry window opened from inside the fullscreen takeover, and closing
    // it hands focus back to us; nothing to lift here because it has already gone.
    //
    // DMG templates are set aside and asked about one at a time; everything else goes in at once.
    const plain = [];
    const templates = [];
    for ( const uuid of selected ) {
      const item = await fromUuid(uuid).catch(() => null);
      if ( item && isMakeable(item) ) templates.push(item);
      else plain.push(uuid);
    }
    if ( plain.length ) this.#reportAdded(await addStockItems(trader, plain, { synthesize: false }));
    for ( const template of templates ) await this.#stockTemplate(trader, template);
  }

  /**
   * The Stock tab's "Magic item…" button: choose any DMG template the world has, then what to make
   * from it. The same chooser a dropped template opens, with the template picker shown as well.
   */
  static async #onMakeMagicItem() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;
    ui.notifications.info(t("manager.enchant.loading"));
    const templates = await templateCatalogue(await itemPool());
    if ( !templates.length ) return void ui.notifications.warn(t("manager.enchant.noTemplates"));
    await this.#stockTemplate(trader, null, templates);
  }

  /**
   * The Stock tab's "Spell scroll…" button: pick spells in the system's compendium browser, and stock
   * a scroll of each.
   */
  static async #onMakeScroll() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;
    const browser = globalThis.dnd5e?.applications?.CompendiumBrowser;
    if ( !browser?.select ) return void ui.notifications.warn(t("manager.generate.noBrowser"));
    const selected = await browser.select({
      filters: { locked: { documentClass: "Item", types: new Set(["spell"]) } },
      selection: { min: 0, max: null }
    });
    if ( !selected?.size ) return;
    const scrolls = [];
    for ( const uuid of selected ) {
      const data = await makeScrollData(uuid);
      if ( data ) scrolls.push(data);
    }
    if ( !scrolls.length ) return void ui.notifications.warn(t("error.cannotScroll"));
    this.#reportAdded({ ...(await addMadeStock(trader, scrolls)), rejected: [] });
  }

  /**
   * Ask the GM what to make from a DMG template, and stock it.
   *
   * "Weapon, +1, +2, or +3" is three enchantments and forty weapons; the GM picks one of each and
   * gets a real "Longsword +1" on the shelf. The base list follows the enchantment chosen, because
   * each enchantment has its own rules about what it can go on.
   * With a `catalogue`, the dialog also offers every template to choose from, and reloads the other
   * two lists when the template changes.
   * @param {object} trader
   * @param {object|null} template  The dropped or picked template, or null to choose from the catalogue.
   * @param {{uuid: string, name: string, packLabel: string}[]} [catalogue]
   * @returns {Promise<boolean>}  Whether anything was stocked.
   */
  async #stockTemplate(trader, template, catalogue = null) {
    const esc = foundry.utils.escapeHTML;
    const load = async target => {
      const { template: doc, choices } = await templateChoices(target);
      return { doc, choices };
    };
    let current = await load(template ?? catalogue?.[0]?.uuid);
    if ( !current.choices.length ) {
      ui.notifications.warn(t("manager.enchant.noBases", { name: current.doc?.name ?? "" }));
      return false;
    }

    const baseOptions = (state, choice) => {
      const templateValueCp = itemValueCp(state.doc?.system?.price);
      return choice.bases.map(b => {
        const price = formatCp(b.valueCp + enchantmentValueCp({
          profile: choice.profile, templateValueCp, consumable: b.type === "consumable"
        }));
        return `<option value="${b.uuid}">${esc(b.name)} — ${price}</option>`;
      }).join("");
    };
    const profileOptions = state => state.choices.map(c => {
      const rarity = c.profile.rarity ? ` (${t(`rarity.${c.profile.rarity}`)})` : "";
      return `<option value="${c.profile.key}">${esc(c.profile.name || state.doc.name)}${rarity}</option>`;
    }).join("");
    const templatePicker = catalogue ? `<label>${t("manager.enchant.template")}
        <select name="template">${catalogue.map(c => `<option value="${c.uuid}">${esc(c.name)}${c.packLabel ? ` — ${esc(c.packLabel)}` : ""}</option>`).join("")}</select>
      </label>` : "";

    const picked = await foundry.applications.api.DialogV2.prompt({
      window: {
        title: catalogue ? t("manager.enchant.titleAny") : t("manager.enchant.title", { name: current.doc.name }),
        icon: "fa-solid fa-wand-sparkles"
      },
      classes: ["sogrom-shop-dialog"],
      position: { width: 480 },
      content: `<p>${t("manager.enchant.body")}</p>
        <div class="shop-enchant-fields">
          ${templatePicker}
          <label>${t("manager.enchant.enchantment")}
            <select name="profile">${profileOptions(current)}</select>
          </label>
          <label>${t("manager.enchant.base")}
            <select name="base">${baseOptions(current, current.choices[0])}</select>
          </label>
        </div>`,
      render: (_event, dialog) => {
        const root = dialog.element;
        const templateSelect = root.querySelector("[name=template]");
        const profile = root.querySelector("[name=profile]");
        const base = root.querySelector("[name=base]");
        profile?.addEventListener("change", () => {
          const choice = current.choices.find(c => c.profile.key === profile.value);
          if ( choice && base ) base.innerHTML = baseOptions(current, choice);
        });
        templateSelect?.addEventListener("change", async () => {
          const next = await load(templateSelect.value);
          if ( !next.choices.length ) return;
          current = next;
          profile.innerHTML = profileOptions(current);
          base.innerHTML = baseOptions(current, current.choices[0]);
        });
      },
      ok: {
        label: t("manager.enchant.add"),
        icon: "fa-solid fa-plus",
        callback: (_event, button) => ({
          profileKey: button.form.elements.profile.value,
          baseUuid: button.form.elements.base.value
        })
      },
      rejectClose: false
    });
    if ( !picked ) return false;

    const data = await makeEnchantedData({ template: current.doc, ...picked });
    if ( !data ) {
      ui.notifications.warn(t("manager.enchant.failed", { name: current.doc.name }));
      return false;
    }
    this.#reportAdded({ ...(await addMadeStock(trader, [data])), rejected: [] });
    return true;
  }

  /** Run the rarity-budget generator. */
  static async #onGenerateStock() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;

    if ( budgetTotal(this.#generator.budget) <= 0 ) {
      return void ui.notifications.warn(t("manager.generate.emptyBudget"));
    }
    // Through the same path an archetype's "apply with stock" and the API use, so the three can
    // never disagree about what a recipe produces.
    await this.#runRecipe(trader, this.#recipe());
  }

  /**
   * Fill a Trader's shelves from a recipe and report what happened.
   *
   * Says what could not be found rather than quietly handing back fewer: a GM whose packs hold
   * two legendary items should be told that, not left to conclude the generator is broken.
   */
  async #runRecipe(trader, recipe) {
    const result = await stockFromRecipe(trader, recipe);
    const gaps = Object.entries(result.shortfalls);
    if ( gaps.length ) {
      ui.notifications.warn(t("manager.generate.shortfall", {
        detail: gaps.map(([key, n]) => `${n} ${key ? t(`rarity.${key}`) : t("rarity.mundane")}`)
          .join(", ")
      }));
    }
    if ( !result.picked ) return;
    this.#reportAdded(result);
  }

  /** Draw stock from a RollTable. */
  static async #onDrawFromTable() {
    const trader = getTrader(this.#selected);
    const table = game.tables.get(this.#generator.tableId);
    if ( !trader ) return;
    if ( !table ) return void ui.notifications.warn(t("manager.generate.noTable"));

    const uuids = await rollTableStock(table, this.#generator.draws);
    if ( !uuids.length ) return void ui.notifications.warn(t("manager.generate.tableNoItems"));
    await this.#addUuids(trader, uuids);
  }

  /**
   * Add a batch of uuids and report what happened.
   *
   * One report line rather than one per item: generating thirty lines would otherwise bury the
   * screen in notifications.
   */
  async #addUuids(trader, uuids) {
    this.#reportAdded(await addStockItems(trader, uuids));
  }

  /** One report for a batch of added stock, then show the Stock tab it landed in. */
  #reportAdded({ created, raised, failed, rejected, full = [] }) {
    ui.notifications.info(t("manager.generate.added", {
      created: created.length, raised: raised.length
    }));
    if ( full.length ) {
      ui.notifications.warn(t("manager.stock.full", { count: full.length, max: maxStockLines() }));
    }
    if ( rejected.length ) {
      // Overwhelmingly a roll table that also rolls spells or features. Naming them beats a bare
      // count, because the GM's next move is to fix the table.
      log("not stockable, so skipped", rejected);
      ui.notifications.warn(t("manager.generate.notStockable", {
        count: rejected.length,
        names: rejected.slice(0, 3).map(r => r.name).join(", ")
      }));
    }
    if ( failed.length ) {
      log("stock uuids that could not be resolved", failed);
      ui.notifications.warn(t("manager.generate.someFailed", { count: failed.length }));
    }
    this.#tab = "stock";
    this.render({ parts: ["rail", "pane"] });
  }

  /** Empty a Trader's shelves, with a confirmation — this is a lot of work to undo by hand. */
  static async #onClearStock() {
    const trader = getTrader(this.#selected);
    if ( !trader || !stockEntries(trader).length ) return;

    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("manager.stock.clearTitle"), icon: "fa-solid fa-trash-can" },
      content: `<p>${t("manager.stock.clearBody", {
        count: stockEntries(trader).length, name: trader.name
      })}</p>`,
      rejectClose: false
    });
    if ( !proceed ) return;

    await trader.deleteEmbeddedDocuments("Item", trader.items.map(i => i.id));
    this.render({ parts: ["rail", "pane"] });
  }

  /** Drop every kind restriction, so the generator draws from everything again. */
  static #onClearCategories() {
    if ( !this.#generator.categories.length ) return;
    this.#generator.categories = [];
    this.render({ parts: ["pane"] });
  }

  static #onToggleGenerator() {
    this.#generator.open = !this.#generator.open;
    this.render({ parts: ["pane"] });
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#wireDragDrop();
    this.#wireFields();
    this.#restoreDetails();
    this.#restoreFocus();
  }

  /**
   * Which collapsible blocks the GM has opened, as of the last render.
   *
   * A `<details>` element keeps its open state in the DOM and nowhere else, so a re-render
   * closes it. That is not a cosmetic problem here: ticking a compendium re-renders the pane to
   * update the counts, which slammed shut the very list the GM was ticking through — and took
   * the focus with it, since a control inside a closed block cannot hold focus.
   *
   * Captured in {@link _preRender} and reapplied in `_onRender`. Held per element id rather than
   * as one flag, so a future collapsible needs no new code.
   * @type {Set<string>}
   */
  #openDetails = new Set();

  /**
   * A selector for the control to put the focus back on after a re-render.
   *
   * Same problem, one level down: rebuilding the pane destroys the element that was just
   * clicked, so the focus falls back to the document and a keyboard user loses their place
   * mid-list. Recorded on change and restored after the render that follows.
   * @type {string|null}
   */
  #refocus = null;

  /**
   * Record which collapsible blocks are open, from the live DOM, just before it is replaced.
   *
   * This is the second version. The first tracked open state through each block's `toggle`
   * event, which looks equivalent and is not: `toggle` is queued as a *task*, while a re-render
   * whose data is already cached completes entirely in *microtasks*. So opening a block and
   * ticking a box inside it promptly — or doing it from the keyboard — let the re-render finish
   * before the event arrived, and the block closed anyway. The late event then landed on an
   * element that had already been thrown away.
   *
   * Reading the DOM here instead has no timing to get wrong: whatever is open at the moment the
   * markup is replaced is, by definition, what the GM had open.
   * @override
   */
  async _preRender(context, options) {
    await super._preRender(context, options);
    if ( !this.element ) return;                 // the first render has no previous DOM
    for ( const details of this.element.querySelectorAll("[data-shop-details]") ) {
      const id = details.dataset.shopDetails;
      if ( details.open ) this.#openDetails.add(id);
      else this.#openDetails.delete(id);
    }
  }

  /** Re-open whatever was open before the render. */
  #restoreDetails() {
    for ( const details of this.element.querySelectorAll("[data-shop-details]") ) {
      // A template may render a block open on its own account — the kinds picker does once a
      // kind is chosen — so an open block is never forced shut here, only closed ones reopened.
      if ( this.#openDetails.has(details.dataset.shopDetails) ) details.open = true;
    }
  }

  /** Put the focus back where it was, if the control still exists. */
  #restoreFocus() {
    if ( !this.#refocus ) return;
    const target = this.element.querySelector(this.#refocus);
    this.#refocus = null;
    target?.focus({ preventScroll: true });
  }

  /**
   * Accept an item dropped anywhere on the window.
   *
   * Wired once: the window's root element survives a re-render, the part contents do not, so
   * re-wiring per render would stack listeners and add an item once per render since the window
   * opened.
   */
  #wireDragDrop() {
    if ( this.#dndWired ) return;
    this.#dndWired = true;
    const root = this.element;
    root.addEventListener("dragover", event => {
      event.preventDefault();
      root.classList.add("is-dragover");
    });
    root.addEventListener("dragleave", event => {
      // `dragleave` fires on every child boundary crossed, so the highlight would flicker
      // constantly without checking whether the pointer actually left the window.
      if ( event.relatedTarget && root.contains(event.relatedTarget) ) return;
      root.classList.remove("is-dragover");
    });
    root.addEventListener("drop", event => this.#onDrop(event));
  }

  /**
   * Commit a field on `change` — blur or Enter, not per keystroke.
   *
   * Re-wired every render because the inputs are inside the part content, which is rebuilt.
   * That is safe where the drop listener is not: these are fresh elements each time, so there
   * is nothing to stack onto.
   */
  #wireFields() {
    for ( const field of this.element.querySelectorAll("[data-shop-field]") ) {
      field.addEventListener("change", event => this.#onFieldChange(event));
    }
  }

  /* -------------------------------------------- */
  /*  Field commits                               */
  /* -------------------------------------------- */

  /**
   * Write one changed field.
   *
   * Rows are addressed by `data-` attributes rather than by form-field `name`s. Foundry's form
   * serialisation runs names through `expandObject`, which treats dots as path separators — and
   * while an embedded-item id is safe today, the flag path these write into is not, and a
   * name-based table would quietly become a nested-object bug the first time an id or a key
   * gained a dot. Reading the row from the DOM sidesteps the question entirely.
   */
  async #onFieldChange(event) {
    const input = event.currentTarget;
    const field = input.dataset.shopField;
    const trader = getTrader(this.#selected);
    if ( !trader ) return;

    // Noted before anything is written, because a write may re-render and destroy this element.
    this.#refocus = focusSelector(input);

    // Generator inputs belong to neither the Trader nor an item — they are this window's own
    // scratch state, and they must not write a document. Checked first, because the generator
    // panel sits inside the Stock pane and would otherwise fall through to the Trader branch.
    if ( field.startsWith("gen.") ) return this.#commitGeneratorField(field.slice(4), input);

    // Pickers that only change what this window shows: the archetype being read and the ledger's
    // character filter. Neither is a property of the Trader, so neither writes anything.
    if ( field === "view.archetype" ) {
      this.#archetypeId = input.value;
      return void this.render({ parts: ["pane"] });
    }
    if ( field === "view.ledgerActor" ) {
      this.#ledgerActor = input.value;
      return void this.render({ parts: ["pane"] });
    }

    const itemId = input.closest("[data-item-id]")?.dataset.itemId;
    if ( itemId ) return this.#commitStockField(trader, itemId, field, input);
    return this.#commitTraderField(trader, field, input);
  }

  /**
   * A generator control. Held on the instance, never persisted: a generation recipe is a
   * momentary intent, not a Trader's configuration, and storing it would mean a migration for
   * a field nobody would miss.
   *
   * Only the inputs that change what is *available* trigger a re-render — the budget counts do
   * not, because re-rendering mid-typing would move the focus out of the box being typed in.
   */
  async #commitGeneratorField(field, input) {
    const state = this.#generator;
    let rerender = false;

    if ( field.startsWith("budget.") ) {
      const key = field.slice(7);
      state.budget = sanitizeBudget({ ...state.budget, [key]: input.value });
      // Reflect the clamp back, so a typed 5000 visibly becomes 200 rather than lying.
      input.value = state.budget[key];
      return;
    }

    switch ( field ) {
      case "maxValue":
      case "maxDenom":
        state[field] = input.value;
        rerender = true;                     // changes the pool, and the counts beside it
        break;
      case "pack": {
        const id = input.dataset.pack;
        state.packs = input.checked
          ? [...new Set([...state.packs, id])]
          : state.packs.filter(p => p !== id);
        rerender = true;
        break;
      }
      case "category": {
        const value = input.dataset.category;
        if ( input.checked ) {
          state.categories = [...new Set([...state.categories, value])];
        } else {
          // Unticking a whole type also unticks its subtypes. Leaving them behind would mean
          // the type's box was clear while the generator still only drew from part of it —
          // a filter doing something the UI no longer shows.
          state.categories = state.categories.filter(c => c !== value && !c.startsWith(`${value}:`));
        }
        rerender = true;
        break;
      }
      case "tableId":
        state.tableId = input.value;
        break;
      case "draws":
        state.draws = Math.max(1, Math.min(100, Math.round(Number(input.value) || 1)));
        input.value = state.draws;
        break;
      default:
        log(`unhandled generator field "${field}"`);
        return;
    }
    if ( rerender ) this.render({ parts: ["pane"] });
  }

  /** An identity field on the Trader itself. */
  async #commitTraderField(trader, field, input) {
    switch ( field ) {
      case "name": {
        const name = input.value.trim();
        // An actor with no name is unopenable in the sidebar, so refuse rather than write it.
        if ( !name ) {
          input.value = trader.name;
          return;
        }
        await trader.update({ name });
        break;
      }
      case "greeting":
        await trader.setFlag(MODULE_ID, "greeting", input.value);
        break;
      case "startingAttitude":
        await trader.setFlag(MODULE_ID, "startingAttitude", Number(input.value));
        break;
      case "currency": {
        const denomination = input.dataset.denomination;
        const amount = Math.max(0, Math.round(Number(input.value) || 0));
        await trader.update({ [`system.currency.${denomination}`]: amount });
        break;
      }
      case "allowAll":
        await trader.setFlag(MODULE_ID, "buyFilter.allowAll", input.checked);
        break;
      case "filterType":
      case "filterRarity": {
        // Read the whole group back rather than patching one entry: a checkbox group is one
        // decision, and writing it entry by entry would leave the flag half-updated if a
        // re-render landed in between.
        const key = field === "filterType" ? "types" : "rarities";
        const selected = [...this.element.querySelectorAll(`[data-shop-field="${field}"]`)]
          .filter(box => box.checked)
          .map(box => box.dataset.value);
        await trader.setFlag(MODULE_ID, `buyFilter.${key}`, selected);
        break;
      }
      case "allUnlimited":
      case "noStockLimit":
        await trader.setFlag(MODULE_ID, field, input.checked);
        break;
      case "restockMode":
        await trader.setFlag(MODULE_ID, "restock.mode", input.value);
        break;
      case "restockDays":
        await trader.setFlag(MODULE_ID, "restock.days", Number(input.value));
        break;
      case "gainCustom":
        // Switching the override on seeds it from the world's values, so the fields the GM is
        // about to edit start from what was actually in force rather than from zero.
        await trader.setFlag(MODULE_ID, "attitudeGain", input.checked
          ? {
            cpPerPoint: Number(setting(SETTINGS.attitudeGainPerPoint)) || 0,
            capPerVisit: Number(setting(SETTINGS.attitudeGainCap)) || 0
          }
          : null);
        break;
      case "gainPerPoint":
      case "gainCap": {
        const current = traderData(trader).attitudeGain ?? gainSettings(trader);
        const key = field === "gainPerPoint" ? "cpPerPoint" : "capPerVisit";
        await trader.setFlag(MODULE_ID, "attitudeGain", {
          ...current, [key]: Math.max(0, Math.round(Number(input.value) || 0))
        });
        break;
      }
      case "attitude": {
        const characterId = input.closest("[data-character-id]")?.dataset.characterId;
        if ( characterId ) await setAttitude(trader, characterId, Number(input.value));
        break;
      }
      default:
        log(`unhandled trader field "${field}"`);
        return;
    }
    this.render({ parts: ["rail", "pane"] });
  }

  /** One control on one stock row. */
  async #commitStockField(trader, itemId, field, input) {
    const item = trader.items.get(itemId);
    if ( !item ) return;

    switch ( field ) {
      case "quantity":
        await item.update({ "system.quantity": Math.max(0, Math.round(Number(input.value) || 0)) });
        break;
      case "unlimited":
        await item.setFlag(MODULE_ID, "unlimited", input.checked);
        break;
      case "baseQty":
        await item.setFlag(MODULE_ID, "baseQty", Math.max(1, Math.round(Number(input.value) || 1)));
        break;
      case "revealAt": {
        // Blank means "always visible", which is null rather than 0 — 0 is a real threshold
        // meaning "visible even to a Trader that loathes you".
        const raw = input.value.trim();
        await item.setFlag(MODULE_ID, "revealAt", raw === "" ? null : Number(raw));
        break;
      }
      case "overrideValue":
      case "overrideDenom": {
        const row = input.closest("[data-item-id]");
        const value = row.querySelector("[data-shop-field='overrideValue']")?.value;
        const denomination = row.querySelector("[data-shop-field='overrideDenom']")?.value;
        await item.setFlag(MODULE_ID, "overrideCp", parsePriceInput(value, denomination));
        break;
      }
      default:
        log(`unhandled stock field "${field}"`);
        return;
    }
    this.render({ parts: ["rail", "pane"] });
  }

  /* -------------------------------------------- */
  /*  Drag and drop                               */
  /* -------------------------------------------- */

  /**
   * An item dropped on the window joins the selected Trader's stock.
   *
   * Validated as priced physical gear before it lands: a spell or a class dropped from a
   * compendium would otherwise become a stock line nothing can price. An *unpriced* physical
   * item is accepted with a warning rather than refused, because a price override is exactly
   * how a GM sells something the system gives no value — a quest reward, a unique blade.
   */
  async #onDrop(event) {
    event.preventDefault();
    this.element.classList.remove("is-dragover");

    const trader = getTrader(this.#selected);
    if ( !trader ) return void ui.notifications.warn(t("manager.stock.dropNoTrader"));

    let data = null;
    try {
      data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    } catch {
      data = null;
    }
    if ( (data?.type === "Folder") || (data?.type === "Compendium") ) return this.#stockFolder(trader, data);
    if ( data?.type !== "Item" ) return;

    const item = await Item.implementation.fromDropData(data).catch(() => null);
    if ( !item ) return void ui.notifications.warn(t("manager.stock.dropNotItem"));

    // A spell becomes a scroll of that spell, as it would in a character's inventory.
    if ( item.type === "spell" ) {
      const scroll = await makeScrollData(item);
      if ( !scroll ) return void ui.notifications.warn(t("manager.stock.dropNotPhysical", { name: item.name }));
      this.#reportAdded({ ...(await addMadeStock(trader, [scroll])), rejected: [] });
      return;
    }
    if ( !PHYSICAL_TYPES.includes(item.type) ) {
      return void ui.notifications.warn(t("manager.stock.dropNotPhysical", { name: item.name }));
    }
    // A DMG template, or a shell, asks what to make from it.
    if ( isMakeable(item) ) {
      await this.#stockTemplate(trader, item);
      return;
    }

    // Routed through the same function the picker, the generator and the API use, rather than
    // building the item data here. This path used to do its own `toObject()` and quietly skipped
    // two things that one does: recording where the item came from (without which a receipt has
    // nothing durable to link) and raising an existing line instead of adding a second row for
    // the same thing.
    const { created, raised, full } = await addStockItems(trader, [item.uuid], { synthesize: false });
    if ( full.length ) return void ui.notifications.warn(t("manager.stock.full", { count: 1, max: maxStockLines() }));
    const landed = created[0] ?? raised[0];
    if ( !landed ) return void ui.notifications.warn(t("manager.stock.dropNotItem"));

    if ( effectiveValueCp(landed, stockLine(landed)) <= 0 ) {
      ui.notifications.warn(t("manager.stock.dropUnpriced", { name: landed.name }));
    }
    this.#tab = "stock";
    this.render({ parts: ["rail", "pane"] });
  }

  /**
   * A folder, or a whole pack, dropped on the window: everything in it joins the stock.
   *
   * Asks first, saying how many and what will be left out, because a pack of three hundred things
   * is a lot to take back off the shelves one line at a time.
   * @param {object} trader
   * @param {object} data  Drop data of type "Folder" or "Compendium".
   */
  async #stockFolder(trader, data) {
    ui.notifications.info(t("manager.stock.dropFolderLoading"));
    const dropped = await droppedFolderItems(data).catch(err => {
      log("could not read the dropped folder", err);
      return null;
    });
    if ( !dropped ) return void ui.notifications.warn(t("manager.stock.dropFolderNotItems"));

    const { plain, spells, templates, skipped } = sortDropped(dropped.items);
    const esc = foundry.utils.escapeHTML;
    const count = plain.length + spells.length;
    if ( !count ) return void ui.notifications.warn(t("manager.stock.dropFolderEmpty", { name: dropped.name }));

    const limit = stockLimit(trader);
    const room = stockRoom(stockEntries(trader).length, limit);
    const notes = [
      spells.length && t("manager.stock.dropFolderScrolls", { count: spells.length }),
      templates.length && t("manager.stock.dropFolderTemplates", { count: templates.length }),
      skipped.length && t("manager.stock.dropFolderSkipped", { count: skipped.length }),
      (count > room) && t("manager.stock.dropFolderRoom", { room, max: limit })
    ].filter(Boolean);
    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("manager.stock.dropFolderTitle"), icon: "fa-solid fa-folder-open" },
      classes: ["sogrom-shop-dialog"],
      content: `<p>${t("manager.stock.dropFolderBody", { count, name: esc(dropped.name), trader: esc(trader.name) })}</p>
        ${notes.map(note => `<p>${note}</p>`).join("")}`
    });
    if ( !proceed ) return;

    const result = plain.length
      ? await addStockItems(trader, plain.map(item => item.uuid), { synthesize: false })
      : { created: [], raised: [], failed: [], rejected: [], full: [] };

    if ( spells.length ) {
      // Only as many scrolls as there is still room for. Each one is a whole item built from the
      // spell, so making three hundred to keep a few would be a long wait for nothing.
      const fits = spells.slice(0, stockRoom(stockEntries(trader).length, limit));
      result.full.push(...spells.slice(fits.length).map(spell => spell.uuid));
      const scrolls = [];
      for ( const spell of fits ) {
        const scroll = await makeScrollData(spell);
        if ( scroll ) scrolls.push(scroll);
        else result.rejected.push({ uuid: spell.uuid, name: spell.name, type: spell.type });
      }
      if ( scrolls.length ) {
        const made = await addMadeStock(trader, scrolls);
        result.created.push(...made.created);
        result.raised.push(...made.raised);
        result.failed.push(...made.failed);
        result.full.push(...made.full);
      }
    }
    this.#reportAdded(result);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onCreateTrader() {
    const actor = await createTrader();
    if ( !actor ) return;
    this.#selected = actor.id;
    this.#tab = "identity";
    this.render();
  }

  static async #onDuplicateTrader(_event, target) {
    const id = target.closest("[data-trader-id]")?.dataset.traderId ?? this.#selected;
    const actor = await duplicateTrader(id);
    if ( !actor ) return;
    this.#selected = actor.id;
    this.render();
  }

  static async #onDeleteTrader(_event, target) {
    const id = target.closest("[data-trader-id]")?.dataset.traderId ?? this.#selected;
    const trader = getTrader(id);
    if ( !trader ) return;

    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("manager.delete.title"), icon: "fa-solid fa-trash-can" },
      content: `<p>${t("manager.delete.body", { name: trader.name })}</p>`,
      rejectClose: false
    });
    if ( !proceed ) return;

    await deleteTrader(id);
    if ( this.#selected === id ) this.#selected = null;
    this.render();
  }

  static #onSelectTrader(_event, target) {
    const id = target.closest("[data-trader-id]")?.dataset.traderId;
    if ( !id || id === this.#selected ) return;
    this.#selected = id;
    this.render({ parts: ["rail", "pane"] });
  }

  static #onSelectTab(_event, target) {
    const tab = target.dataset.tab;
    if ( !tab || tab === this.#tab ) return;
    if ( !this.constructor.TABS.find(t2 => t2.id === tab)?.ready ) return;
    this.#tab = tab;
    this.render({ parts: ["pane"] });
  }

  static async #onPickPortrait() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;

    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: trader.img,
      callback: path => trader.update({ img: path })
        .then(() => this.render({ parts: ["rail", "pane"] }))
    });

    // Claimed *before* rendering, not after. `render()` resolves asynchronously, so reaching for
    // `picker.element` on the next line finds null and the picker opens behind the full-screen
    // window — which is exactly the bug this replaced. `yieldTakeoverTo` marks the application
    // and the render watcher finishes the job when the element exists.
    yieldTakeoverTo(picker);
    picker.render(true);
  }

  static async #onRemoveStock(_event, target) {
    const trader = getTrader(this.#selected);
    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    if ( !trader || !itemId ) return;
    await trader.deleteEmbeddedDocuments("Item", [itemId]);
    this.render({ parts: ["rail", "pane"] });
  }

  static async #onOpenStockItem(_event, target) {
    const trader = getTrader(this.#selected);
    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const item = trader?.items.get(itemId);
    if ( !item ) return;
    const sheet = item.sheet;
    yieldTakeoverTo(sheet);
    sheet.render(true);
  }

  /* -------------------------------------------- */

  /** Post the selected Trader's card to chat, which is how a shop reaches the players. */
  static async #onPostCard() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;
    await postTraderCard(trader.id);
    ui.notifications.info(t("manager.posted", { name: trader.name }));
  }

  /**
   * Open the selected Trader's shop on every connected player's screen, and say who got it.
   */
  static async #onShowToPlayers() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;
    if ( !game.users.some(u => u.active && !u.isGM) ) {
      return void ui.notifications.warn(t("manager.show.nobody"));
    }
    try {
      const { opened, skipped } = await showToPlayers(trader.id);
      if ( opened.length ) {
        ui.notifications.info(t("manager.show.opened", { name: trader.name, players: opened.join(", ") }));
      }
      if ( skipped.length ) {
        ui.notifications.warn(t("manager.show.skipped", {
          players: skipped.map(x => `${x.name} (${t(`manager.show.reason.${x.reason}`)})`).join(", ")
        }));
      }
    } catch ( err ) {
      ui.notifications.warn(err.message);
    }
  }

  /**
   * Open the shop as the GM, to see what the players will see.
   *
   * Opens against the GM's own assigned character when they have one, because the whole window
   * is priced for a specific character and there is nothing sensible to show without one.
   */
  static async #onOpenShopAsGM() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;
    await ShopApp.open({ traderId: trader.id });
  }

  /** Refill the shelves now, whatever the Trader's restock mode says. */
  static async #onRestockNow() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;
    const result = await restockTrader(trader);
    ui.notifications.info(result.added.length
      ? t("manager.trading.restocked", { count: result.added.length })
      : t("manager.trading.nothingToRestock"));
    this.render({ parts: ["rail", "pane"] });
  }

  /**
   * Forget a Trader's opinion of one character, returning them to its starting attitude.
   *
   * Deleting the stored entry rather than writing the default into it, so a later change to the
   * Trader's own starting attitude still applies to them — which is what "forget" should mean.
   */
  static async #onResetAttitude(_event, target) {
    const trader = getTrader(this.#selected);
    const characterId = target.closest("[data-character-id]")?.dataset.characterId;
    if ( !trader || !characterId ) return;
    await trader.unsetFlag(MODULE_ID, `attitude.${characterId}`);
    await trader.unsetFlag(MODULE_ID, `spend.${characterId}`);
    await trader.unsetFlag(MODULE_ID, `haggle.${characterId}`);
    this.render({ parts: ["pane"] });
  }

  /* -------------------------------------------- */
  /*  Archetypes                                  */
  /* -------------------------------------------- */

  /** The archetype chosen in the picker, if it still exists. */
  #chosenArchetype() {
    return listArchetypes().find(a => a.id === this.#archetypeId) ?? null;
  }

  /**
   * Give the selected Trader the chosen archetype's character, and prime the generator with its
   * recipe so the Stock tab is one click from running it.
   */
  static async #onApplyArchetype() {
    const trader = getTrader(this.#selected);
    const archetype = this.#chosenArchetype();
    if ( !trader || !archetype ) return;
    await applyArchetype(trader, archetype);
    Object.assign(this.#generator, recipeToGenerator(archetype.recipe, cpToPriceParts));
    ui.notifications.info(t("manager.archetype.applied", {
      archetype: archetypeName(archetype), name: trader.name
    }));
    this.render({ parts: ["rail", "pane"] });
  }

  /** Apply the archetype, then fill the shelves from its recipe and show them. */
  static async #onApplyArchetypeStock() {
    const trader = getTrader(this.#selected);
    const archetype = this.#chosenArchetype();
    if ( !trader || !archetype ) return;
    await applyArchetype(trader, archetype);
    Object.assign(this.#generator, recipeToGenerator(archetype.recipe, cpToPriceParts));
    this.#generator.open = true;
    await this.#runRecipe(trader, archetype.recipe);
    this.#tab = "stock";
    this.render({ parts: ["rail", "pane"] });
  }

  /**
   * Save the selected Trader as an archetype: its buy filter, restock rule and starting attitude,
   * with the generator panel's current recipe as the stock recipe.
   */
  static async #onSaveArchetype() {
    const trader = getTrader(this.#selected);
    if ( !trader ) return;

    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("manager.archetype.saveTitle"), icon: "fa-solid fa-floppy-disk" },
      content: `<p>${t("manager.archetype.saveBody")}</p>
        <label class="shop-field"><span>${t("manager.archetype.nameLabel")}</span>
        <input type="text" name="archetypeName" value="${foundry.utils.escapeHTML(trader.name)}"
               autocomplete="off" autofocus required></label>`,
      ok: {
        label: t("manager.archetype.save"),
        callback: (_event, button) => button.form.elements.archetypeName.value.trim()
      },
      rejectClose: false
    });
    if ( !name ) return;

    try {
      const saved = await saveArchetype(archetypeFromTrader({
        id: foundry.utils.randomID(),
        name,
        data: traderData(trader),
        recipe: this.#recipe()
      }));
      this.#archetypeId = saved.id;
      ui.notifications.info(t("manager.archetype.savedNotice", { name: saved.name }));
    } catch ( err ) {
      ui.notifications.warn(err.message);
    }
    this.render({ parts: ["pane"] });
  }

  /** Delete the chosen saved archetype. Built-ins offer no delete button, and refuse anyway. */
  static async #onDeleteArchetype() {
    const archetype = this.#chosenArchetype();
    if ( !archetype || archetype.builtIn ) return;

    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("manager.archetype.deleteTitle"), icon: "fa-solid fa-trash-can" },
      content: `<p>${t("manager.archetype.deleteBody", { name: foundry.utils.escapeHTML(archetype.name) })}</p>`,
      rejectClose: false
    });
    if ( !proceed ) return;

    await deleteArchetype(archetype.id);
    this.#archetypeId = BUILT_IN_ARCHETYPES[0].id;
    this.render({ parts: ["pane"] });
  }

  /* -------------------------------------------- */
  /*  Export and import                           */
  /* -------------------------------------------- */

  /**
   * Download a Trader as a file another world can import. Stock travels whole; what the Trader
   * thinks of this world's characters, and its ledger, do not — see data/portable.mjs.
   */
  static #onExportTrader(_event, target) {
    const id = target.closest("[data-trader-id]")?.dataset.traderId ?? this.#selected;
    const trader = getTrader(id);
    if ( !trader ) return;
    const file = exportTrader(trader.toObject(), {
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? "",
      exportedAt: new Date().toISOString()
    });
    foundry.utils.saveDataToFile(JSON.stringify(file, null, 2), "application/json",
      exportFileName(trader.name));
    ui.notifications.info(t("manager.export.done", { name: trader.name, count: file.items.length }));
  }

  /** Create a Trader from an export file the GM picks. */
  static async #onImportTrader() {
    const file = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("manager.import.title"), icon: "fa-solid fa-file-import" },
      content: `<p>${t("manager.import.body")}</p>
        <input type="file" name="traderFile" accept=".json,application/json" required>`,
      ok: {
        label: t("manager.import.button"),
        callback: (_event, button) => button.form.elements.traderFile.files?.[0] ?? null
      },
      rejectClose: false
    });
    if ( !file ) return;

    let text;
    try {
      text = await foundry.utils.readTextFromFile(file);
    } catch {
      return void ui.notifications.warn(t("error.import.unreadable"));
    }

    const { actor, error, items, dropped } = await importTrader(text);
    if ( error ) return void ui.notifications.warn(t(`error.import.${error}`));

    this.#selected = actor.id;
    this.#tab = "identity";
    ui.notifications.info(t("manager.import.done", { name: actor.name, count: items }));
    if ( dropped ) ui.notifications.warn(t("manager.import.dropped", { count: dropped, max: maxStockLines() }));
    this.render();
  }

  /* -------------------------------------------- */
  /*  Ledger                                      */
  /* -------------------------------------------- */

  /** Empty the selected Trader's ledger, after asking. Receipts already in chat are untouched. */
  static async #onClearLedger() {
    const trader = getTrader(this.#selected);
    if ( !trader || !ledgerOf(trader).length ) return;

    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("manager.ledger.clearTitle"), icon: "fa-solid fa-trash-can" },
      content: `<p>${t("manager.ledger.clearBody", { name: foundry.utils.escapeHTML(trader.name) })}</p>`,
      rejectClose: false
    });
    if ( !proceed ) return;

    await clearLedger(trader);
    this.#ledgerActor = "";
    this.render({ parts: ["pane"] });
  }

  /**
   * Heal the registry on the way out.
   *
   * Reading the registry never writes (two clients reading at once would race), so the prune
   * happens here — the manager is the only place that changes the Trader set, so closing it is
   * exactly when the stored order is worth reconciling.
   * @override
   */
  async close(options) {
    await pruneRegistry().catch(err => log("registry prune failed", err));
    return super.close(options);
  }

  /** @override */
  get title() {
    return t("manager.title");
  }

  /** Exposed for the pricing pane in M8, which previews against every preset. */
  static get presets() {
    return PRICING_PRESETS;
  }

  /** Exposed for the attitudes pane in M6. */
  static attitudeOf(trader, character) {
    return getAttitude(trader, character);
  }
}

/* -------------------------------------------- */
/**
 * An archetype's display name: a built-in's is a localisation key, a saved one's is the GM's own.
 * @param {import("../data/archetypes.mjs").Archetype} archetype
 * @returns {string}
 */
function archetypeName(archetype) {
  return archetype.builtIn ? game.i18n.localize(archetype.name) : archetype.name;
}

/* -------------------------------------------- */
/**
 * A selector that will find this control again after its element has been rebuilt.
 *
 * Identity has to come from the data attributes rather than from the element, because the
 * element itself does not survive a re-render. A checkbox in a list needs its list key too —
 * `data-shop-field="category"` alone matches forty of them.
 * @param {HTMLElement} input
 * @returns {string|null}
 */
function focusSelector(input) {
  const field = input?.dataset?.shopField;
  if ( !field ) return null;
  for ( const key of ["pack", "category", "value", "denomination"] ) {
    const value = input.dataset[key];
    if ( value !== undefined ) {
      return `[data-shop-field="${field}"][data-${key}="${CSS.escape(value)}"]`;
    }
  }
  // A row's controls are unique within their row, which is keyed by the item or character it is.
  const row = input.closest("[data-item-id], [data-character-id]");
  const rowId = row?.dataset?.itemId ?? row?.dataset?.characterId;
  if ( rowId ) {
    const attr = row.dataset.itemId ? "data-item-id" : "data-character-id";
    return `[${attr}="${CSS.escape(rowId)}"] [data-shop-field="${field}"]`;
  }
  return `[data-shop-field="${field}"]`;
}
