import { HOOKS, MODULE_ID, fireHook, log, t, tpl } from "../config.mjs";
import { categoryTokens } from "../data/generate.mjs";
import { formatCp } from "../data/pricing.mjs";
import { QUERIES, askGM, gmAvailable } from "../trade/queries.mjs";
import { ShopShellBase } from "./shell-base.mjs";
import { categoryOptions } from "./categories.mjs";
import { yieldTakeoverTo } from "./takeover.mjs";
import { lineBreakdown, rateBreakdown, signed } from "./price-breakdown.mjs";
import { ShopState } from "./shop-state.mjs";

/**
 * The player-facing shop: a full-screen counter with the Trader's shelves on one side, the
 * character's pack on the other, and what is being offered in between.
 *
 * ## Where its data comes from
 *
 * Nowhere local. Players have no ownership of Trader actors, so this window cannot read the
 * Trader at all — it asks a GM client for a context payload and renders that
 * ({@link module:trade/context}). Everything on screen, prices included, arrives over the wire
 * already computed, and the confirm button sends back **ids and quantities only**. A tampered
 * client can lie about what it wants; it cannot lie about what that costs.
 *
 * That also means a GM must be online. There is no local fallback, deliberately: one would
 * either be wrong or would require giving players read access to the Trader, which is the thing
 * the whole design avoids.
 *
 * ## What it is responsible for
 *
 * Browsing, staging, settling and both modes are live. The window computes totals for the
 * player's benefit, but every figure is re-derived by the GM on confirmation — see
 * {@link module:trade/transaction}.
 */
export class ShopApp extends ShopShellBase {

  /** @override */
  static DEFAULT_OPTIONS = {
    // One shop window per Trader: `{id}` is substituted with the unique-id the framework
    // assigns, which keeps two different Traders' shops from colliding while still letting
    // `launch()` find an existing one by the id it stores.
    id: `${MODULE_ID}-shop-{id}`,
    window: {
      title: `${MODULE_ID}.shop.title`,
      icon: "fa-solid fa-scale-balanced"
    },
    actions: {
      unstageLine: ShopApp.#onUnstageLine,
      clearCounter: ShopApp.#onClearCounter,
      setMode: ShopApp.#onSetMode,
      confirmTrade: ShopApp.#onConfirmTrade,
      refresh: ShopApp.#onRefresh,
      toggleHistory: ShopApp.#onToggleHistory,
      haggle: ShopApp.#onHaggle
    }
  };

  /**
   * The counter, left to right: your pack, what you are giving and taking, their shelves.
   *
   * Parts render in declaration order, so this order *is* the layout. Your own goods sit on the
   * left because that is where the topbar puts your portrait and purse, and a player's eye
   * should not have to cross the window to reconcile the two.
   * @override
   */
  static PARTS = {
    topbar: { template: tpl("shop/topbar.hbs") },
    pack: { template: tpl("shop/panel-inventory.hbs"), scrollable: [".shop-panel-body"] },
    stage: { template: tpl("shop/panel-stage.hbs"), scrollable: [".shop-panel-body"] },
    stock: { template: tpl("shop/panel-stock.hbs"), scrollable: [".shop-panel-body"] },
    footer: { template: tpl("shop/footer.hbs") }
  };

  /** Every open shop, by `traderId:actorId`, so a second click reuses the window. */
  static #open = new Map();

  /** The staging state. Plain data, no Foundry — see {@link module:app/shop-state}. */
  #state = new ShopState();

  /** Ids rather than documents: a player's client may not be able to resolve the Trader. */
  #traderId = "";
  #actorId = "";

  /**
   * The Group whose purse this deal pays from, or "" for the character's own.
   *
   * Held as a choice rather than trusted as a right: it is sent with every request and the GM
   * re-checks it each time, so a Group the player loses ownership of mid-shop is refused on the
   * next refresh rather than spent from.
   */
  #payerId = "";

  /** Whether the counter is showing this character's past dealings instead of the deal. */
  #showHistory = false;

  /** Set while a confirmation is in flight, so the button cannot be double-submitted. */
  #settling = false;

  /* -------------------------------------------- */
  /*  Launching                                   */
  /* -------------------------------------------- */

  /**
   * Open a shop for a Trader and a character.
   *
   * @param {object} params
   * @param {string} params.traderId
   * @param {object|string} [params.actor]  Defaults to the user's assigned character.
   * @param {object|string} [params.payer]  A Group to pay from; the character's own purse if omitted.
   * @returns {Promise<ShopApp|null>}
   */
  static async open({ traderId, actor, payer } = {}) {
    const character = resolveCharacter(actor);
    if ( !character ) {
      ui.notifications.warn(t("error.noAssignedCharacter"));
      return null;
    }
    if ( !gmAvailable() ) {
      ui.notifications.warn(t("error.noGM"));
      return null;
    }

    const key = `${traderId}:${character.id}`;
    const existing = this.#open.get(key);
    if ( existing ) {
      existing.bringToFront?.();
      await existing.refresh();
      return existing;
    }

    const app = new this();
    app.#traderId = traderId;
    app.#actorId = character.id;
    app.#payerId = (typeof payer === "object" ? payer?.id : payer) ?? "";

    // Fetch before the first render, so the window never appears empty and then fill in — and
    // so a refusal (no such Trader, not your character, a `preOpenShop` veto) surfaces as a
    // notification instead of an empty shop the player has to close.
    try {
      await app.refresh({ render: false });
    } catch ( err ) {
      ui.notifications.warn(err.message);
      return null;
    }

    this.#open.set(key, app);
    await app.render({ force: true });
    fireHook(HOOKS.shopOpened, { app, trader: app.#state.context?.trader, actor: character });
    return app;
  }

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  /**
   * Re-ask the GM for the context and adopt it.
   *
   * Called on open, on the refresh control, after a settlement, and whenever either actor
   * changes (see {@link ShopApp.watchWorld}). `adopt` trims anything staged that no longer
   * exists, so a GM emptying a shelf mid-session cannot leave a player holding an impossible
   * order.
   * @param {object} [options]
   * @param {boolean} [options.render]
   */
  async refresh({ render = true } = {}) {
    const context = await askGM(QUERIES.context, {
      traderId: this.#traderId,
      actorId: this.#actorId,
      payerId: this.#payerId || undefined
    });
    this.#state.adopt(context);
    if ( render ) await this.render();
  }

  /** @override */
  async _prepareContext(options) {
    const base = await super._prepareContext(options);
    const context = this.#state.context;
    if ( !context ) return Object.assign(base, { ready: false });

    const totals = this.#state.totals();
    const purse = this.#state.purse;
    return Object.assign(base, {
      ready: true,
      trader: context.trader,
      actor: context.actor,
      purse,
      purses: context.purses ?? [],
      // Read by a screen reader beside the figure: whose coin it is changes what it means.
      purseLabel: purse?.own === false
        ? t("shop.groupPurse", { name: purse.name })
        : t("shop.yourPurse"),
      showHistory: this.#showHistory,
      history: context.history ?? [],
      attitude: context.attitude,
      multipliers: context.multipliers,
      // Where the multipliers come from, on hover over the rate line.
      rateTooltip: rateBreakdown(context.pricing, this.#breakdownLabels()),
      canHaggle: !!context.haggle?.skills?.some(skill => !skill.locked),
      mode: this.#state.mode,
      barter: this.#state.mode === "barter",
      stock: context.stock.map(line => this.#tile(line, "take")),
      pack: context.pack.map(line => this.#tile(line, "give")),
      // Only the categories each panel actually holds, so the dropdown never offers a choice
      // that would empty the panel.
      stockTypes: categoryOptions(context.stock, this.#state.category.stock),
      packTypes: categoryOptions(context.pack, this.#state.category.pack),
      staged: {
        take: this.#stagedRows("take"),
        give: this.#stagedRows("give")
      },
      totals,
      // "You owe 568" and "You receive 568" are the same figure and opposite situations, so the
      // coin partial is toned rather than the player having to read a sign.
      netTone: totals.owed ? "" : "good",
      coins: this.#coinSlots(purse),
      empty: this.#state.empty,
      settling: this.#settling,
      // The button is enabled only when the deal could actually go through. The GM still
      // re-derives all of it on confirmation — this is courtesy, not enforcement.
      canConfirm: !this.#settling && !this.#state.empty
        && totals.affordable && totals.accepted,
      confirmHint: this.#confirmHint(totals)
    });
  }

  /**
   * One tile's render context.
   *
   * Affordability is judged against the *net* of the whole counter, not this tile's price
   * alone, so a player selling a sword to fund a shield does not see the shield greyed out.
   */
  #tile(line, side) {
    const staged = this.#state.staged(side, line.id);
    const remaining = line.unlimited ? Infinity : line.qty - staged;
    return {
      id: line.id,
      uuid: line.uuid,
      sourceUuid: line.sourceUuid ?? "",
      name: line.name,
      img: line.img,
      rarity: line.rarity,
      qty: line.unlimited ? 0 : line.qty,
      unlimited: line.unlimited,
      price: line.price,
      // Space-separated category tokens, read by the type filter without a re-render.
      categories: categoryTokens(line).join(" "),
      staged,
      // Two different states, deliberately kept apart.
      //
      // `blocked` means this cannot be traded at all — the Trader will not buy it — so the tile
      // is disabled and says why. `exhausted` means every unit is already on the counter, which
      // is not a refusal, just a full hand. It used to be folded into `blocked`, and that
      // disabled the tile; a disabled button receives no mouse events, so right-clicking to put
      // the item back did nothing on precisely the tile most likely to need it — a one-off magic
      // item, where staging the only unit exhausts the line.
      blocked: !!line.blocked,
      exhausted: !line.blocked && remaining <= 0,
      blockedWhy: line.blocked ? line.blockedWhy : null,
      exhaustedNote: (!line.blocked && remaining <= 0) ? t("shop.noneLeft") : null,
      // The character's own gear says what state it is in, and that the state stays with them:
      // a sold item reaches the Trader unequipped and unattuned.
      equipped: !!line.equipped,
      attuned: !!line.attuned,
      statusNote: this.#statusNote(line),
      // What would stop this character using a shelf item, worked out by the GM (`trade/context.mjs`).
      // Advice, not a refusal: the tile stays as buyable as it was.
      warningNote: (line.warnings ?? []).join(" · ")
    };
  }

  /** "Equipped", "Attuned", or both, for a pack line's label; "" when it is neither. */
  #statusNote(line) {
    const parts = [];
    if ( line.equipped ) parts.push(t("shop.equipped"));
    if ( line.attuned ) parts.push(t("shop.attuned"));
    return parts.join(", ");
  }

  /** The words the price breakdown needs, localised once per render. */
  #breakdownLabels() {
    return {
      caption: t("shop.breakdown.caption"),
      listValue: t("shop.breakdown.listValue"),
      fullValue: t("shop.breakdown.fullValue"),
      charisma: mod => t("shop.breakdown.charisma", { mod: mod >= 0 ? `+${mod}` : `${mod}` }),
      attitude: (value, tier) => t("shop.breakdown.attitude", { value, tier }),
      adjusted: t("shop.breakdown.adjusted"),
      youPay: t("shop.breakdown.youPay"),
      theyPay: t("shop.breakdown.theyPay"),
      favour: t("shop.breakdown.favour"),
      each: t("shop.breakdown.each")
    };
  }

  /** The staged lines for one side of the counter, as rows with a running subtotal. */
  #stagedRows(side) {
    const source = side === "take" ? this.#state.context.stock : this.#state.context.pack;
    const rows = [];
    for ( const line of source ) {
      const qty = this.#state.staged(side, line.id);
      if ( qty <= 0 ) continue;
      const unitCp = side === "take" ? line.buyCp : line.sellCp;
      rows.push({
        priceTooltip: lineBreakdown({
          line, side, pricing: this.#state.context.pricing, labels: this.#breakdownLabels()
        }),
        statusNote: side === "give" ? this.#statusNote(line) : "",
        id: line.id,
        uuid: line.uuid,
        sourceUuid: line.sourceUuid ?? "",
        name: line.name,
        img: line.img,
        rarity: line.rarity,
        qty,
        side,
        line: formatCp(unitCp * qty)
      });
    }
    return rows;
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * The text box the player was typing in, if a render is about to replace it.
   *
   * A shop now refreshes itself when the world changes, which can land mid-keystroke — another
   * player's purchase should not yank the caret out of the search box or a coin field.
   * @type {{selector: string, start: number|null, end: number|null}|null}
   */
  #focus = null;

  /** @override */
  async _preRender(context, options) {
    await super._preRender(context, options);
    const active = document.activeElement;
    this.#focus = null;
    if ( !active || !this.element?.contains(active) ) return;
    const { shopSearch, shopCoin, shopCategory, shopPayer } = active.dataset;
    const selector = shopSearch !== undefined ? `[data-shop-search="${shopSearch}"]`
      : shopCoin !== undefined ? `[data-shop-coin="${shopCoin}"]`
        : shopCategory !== undefined ? `[data-shop-category="${shopCategory}"]`
          : shopPayer !== undefined ? "[data-shop-payer]" : "";
    if ( !selector ) return;
    // Number inputs have no selection API; reading it throws in some browsers.
    let start = null;
    let end = null;
    try {
      start = active.selectionStart;
      end = active.selectionEnd;
    } catch {}
    this.#focus = { selector, start, end };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#wireSearch();
    this.#wireCoinFields();
    this.#wirePayer();
    this.#wireItemGestures();
    this.#restoreFocus();
  }

  /** Put the caret back where {@link _preRender} found it, if the box was rebuilt. */
  #restoreFocus() {
    const focus = this.#focus;
    this.#focus = null;
    if ( !focus ) return;
    const box = this.element.querySelector(focus.selector);
    if ( !box || box === document.activeElement || box.disabled ) return;
    box.focus({ preventScroll: true });
    if ( focus.start === null ) return;
    try {
      box.setSelectionRange(focus.start, focus.end);
    } catch {}
  }

  /** Whether the item gestures are attached. The root element outlives each render. */
  #gesturesWired = false;

  /** What is being dragged, while a drag started in this window is in flight. */
  #drag = null;

  /**
   * The drag payload's type. Our own, rather than Foundry's `text/plain` JSON, on purpose: a tile
   * dragged out of the window must mean nothing to a character sheet or the canvas. Given Foundry's
   * `{type: "Item", uuid}` it would be a free copy of the Trader's item for whoever dropped it.
   */
  static DRAG_TYPE = `application/x-${MODULE_ID}-line`;

  /** Items on the shelves or in the pack, and rows on the counter: everything the gestures act on. */
  static ITEM_SELECTOR = ".shop-tile[data-item-id], .shop-staged-row[data-item-id]";

  /**
   * How a player moves goods on and off the counter. A single click deliberately does nothing.
   *
   *  - **Double-click** a tile to put one on the counter; double-click a counter row to take one
   *    back. Shift makes it five, for arrows and rations.
   *  - **Right-click** either for a menu: put one or several on the counter, take one or all back,
   *    or view the item.
   *  - **Drag** a tile onto the counter to put one there (shift: five), or a counter row off it to
   *    take that line back entirely.
   *
   * All of it is delegated from the root element and wired once, because that element survives a
   * re-render while the tiles inside it do not; wiring per render would stack a listener per render.
   */
  #wireItemGestures() {
    if ( this.#gesturesWired ) return;
    this.#gesturesWired = true;
    const root = this.element;

    root.addEventListener("dblclick", event => this.#onItemDoubleClick(event));

    new foundry.applications.ux.ContextMenu(root, ShopApp.ITEM_SELECTOR, this.#menuEntries(), {
      jQuery: false,
      // Fixed, so the menu is drawn in the page's top layer: injected into the tile it would be
      // clipped by the panel's scroll box, and hidden under the full-screen shop.
      fixed: true
    });

    root.addEventListener("dragstart", event => this.#onItemDragStart(event));
    root.addEventListener("dragend", () => this.#endDrag());
    root.addEventListener("dragover", event => this.#onItemDragOver(event));
    root.addEventListener("dragleave", event => {
      const zone = event.target.closest?.(".is-drop-target");
      if ( zone && !zone.contains(event.relatedTarget) ) zone.classList.remove("is-drop-target");
    });
    root.addEventListener("drop", event => this.#onItemDrop(event));
  }

  /**
   * The item an event landed on, and which side of the counter it belongs to.
   * @param {HTMLElement} element
   * @returns {{element: HTMLElement, id: string, side: string, row: boolean, sourceUuid: string}|null}
   */
  #itemAt(element) {
    const item = element?.closest?.(ShopApp.ITEM_SELECTOR);
    if ( !item || !this.element.contains(item) ) return null;
    const side = item.closest("[data-side]")?.dataset.side;
    const id = item.dataset.itemId;
    if ( !side || !id ) return null;
    return {
      element: item, id, side,
      row: item.classList.contains("shop-staged-row"),
      sourceUuid: item.dataset.sourceUuid ?? ""
    };
  }

  /** Change a line on the counter and redraw, unless a confirmation is already on its way. */
  #stage(side, id, delta) {
    if ( this.#settling || !delta ) return;
    if ( this.#state.stage(side, id, delta) ) this.render();
  }

  /** Double-click: a tile goes on the counter, a counter row comes back off it. */
  #onItemDoubleClick(event) {
    // The row's own minus button already takes one back; a quick double press of it must not
    // also count as a double-click on the row and take two more.
    if ( event.target.closest("button:not(.shop-tile-button), input, select, a") ) return;
    const item = this.#itemAt(event.target);
    if ( !item ) return;
    const step = event.shiftKey ? 5 : 1;
    this.#stage(item.side, item.id, item.row ? -step : step);
  }

  /** The right-click menu, shared by tiles and counter rows; each entry decides where it shows. */
  #menuEntries() {
    const at = target => this.#itemAt(target);
    const staged = target => {
      const item = at(target);
      return item ? this.#state.staged(item.side, item.id) : 0;
    };
    const room = target => {
      const item = at(target);
      return item && !item.row ? this.#state.remaining(item.side, item.id) : 0;
    };
    return [
      {
        label: t("shop.menu.addOne"),
        icon: '<i class="fa-solid fa-plus"></i>',
        visible: target => room(target) > 0,
        onClick: (_event, target) => {
          const item = at(target);
          if ( item ) this.#stage(item.side, item.id, 1);
        }
      },
      {
        label: t("shop.menu.addSome"),
        icon: '<i class="fa-solid fa-layer-group"></i>',
        visible: target => room(target) > 1,
        onClick: (_event, target) => this.#promptAdd(at(target))
      },
      {
        label: t("shop.menu.removeOne"),
        icon: '<i class="fa-solid fa-minus"></i>',
        visible: target => staged(target) > 0,
        onClick: (_event, target) => {
          const item = at(target);
          if ( item ) this.#stage(item.side, item.id, -1);
        }
      },
      {
        label: t("shop.menu.removeAll"),
        icon: '<i class="fa-solid fa-xmark"></i>',
        visible: target => staged(target) > 1,
        onClick: (_event, target) => {
          const item = at(target);
          if ( item ) this.#stage(item.side, item.id, -this.#state.staged(item.side, item.id));
        }
      },
      {
        label: t("shop.menu.view"),
        icon: '<i class="fa-solid fa-book-open"></i>',
        visible: target => !!at(target)?.sourceUuid,
        onClick: (event, target) => this.#viewItem(at(target)?.sourceUuid, event)
      }
    ];
  }

  /**
   * Ask how many to put on the counter, capped at what is left of the line.
   * @param {{side: string, id: string, element: HTMLElement}|null} item
   */
  async #promptAdd(item) {
    if ( !item ) return;
    const room = this.#state.remaining(item.side, item.id);
    if ( room <= 0 ) return;
    const name = foundry.utils.escapeHTML(item.element.dataset.name ?? "");
    const max = Number.isFinite(room) ? room : 999;
    const qty = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("shop.menu.addSomeTitle"), icon: "fa-solid fa-layer-group" },
      classes: ["sogrom-shop-dialog"],
      content: `<p>${t("shop.menu.addSomeBody", { name })}</p>
        <input type="number" name="qty" value="1" min="1" max="${max}" step="1" inputmode="numeric" autofocus>`,
      ok: {
        label: t("shop.menu.addSomeButton"),
        icon: "fa-solid fa-plus",
        callback: (_event, button) => Math.floor(Number(button.form.elements.qty.value) || 0)
      },
      rejectClose: false
    });
    // The stock may have moved while the dialog was open; `stage` clamps to what is left anyway.
    if ( qty > 0 ) this.#stage(item.side, item.id, Math.min(qty, max));
  }

  /**
   * Open an item the way a link on a receipt does: its compendium entry, shown through Foundry's
   * own document-link handling, so "View item" and the receipt open exactly the same thing.
   *
   * The uuid is chosen on the GM's side (`data/stock.mjs#sourceUuid`) because a player cannot read
   * the Trader — but they *can* read the compendium the item came from.
   * @param {string} uuid
   * @param {Event} event
   */
  async #viewItem(uuid, event) {
    if ( !uuid ) return;
    const doc = await fromUuid(uuid).catch(() => null);
    if ( !doc?.sheet ) return void ui.notifications.warn(t("shop.menu.viewMissing"));
    // Claimed before rendering, so the sheet is lifted whichever render lands first — see
    // app/takeover.mjs.
    yieldTakeoverTo(doc.sheet);
    doc._onClickDocumentLink(event);
  }

  /** Start dragging a tile toward the counter, or a counter row away from it. */
  #onItemDragStart(event) {
    const item = this.#itemAt(event.target);
    if ( !item ) return;
    // Nothing to move: a refused tile, one already all on the counter, or a deal being confirmed.
    if ( this.#settling || (!item.row && this.#state.remaining(item.side, item.id) <= 0) ) {
      event.preventDefault();
      return;
    }
    this.#drag = item;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(ShopApp.DRAG_TYPE, JSON.stringify({ side: item.side, id: item.id, row: item.row }));
    item.element.classList.add("is-dragging");
  }

  /**
   * Where the drag in flight may land: a tile on the counter, a counter row on the panel its line
   * came from. Anywhere else is not a drop target, so the cursor says so before the player lets go.
   * @param {DragEvent} event
   * @returns {HTMLElement|null}
   */
  #dropZone(event) {
    const drag = this.#drag;
    if ( !drag || !event.dataTransfer?.types?.includes(ShopApp.DRAG_TYPE) ) return null;
    // Not while the counter is showing past dealings: the item would land somewhere out of sight.
    if ( !drag.row ) return event.target.closest?.(".shop-panel--stage:not(.is-history)") ?? null;
    const panel = event.target.closest?.(".shop-panel[data-side]");
    return panel?.dataset.side === drag.side ? panel : null;
  }

  #onItemDragOver(event) {
    const zone = this.#dropZone(event);
    if ( !zone ) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    zone.classList.add("is-drop-target");
  }

  #onItemDrop(event) {
    const zone = this.#dropZone(event);
    const drag = this.#drag;
    this.#endDrag();
    if ( !zone || !drag ) return;
    event.preventDefault();
    if ( drag.row ) this.#stage(drag.side, drag.id, -this.#state.staged(drag.side, drag.id));
    else this.#stage(drag.side, drag.id, event.shiftKey ? 5 : 1);
  }

  /** Clear a drag's leftovers, whether it dropped, was cancelled, or left the window. */
  #endDrag() {
    this.#drag?.element?.classList.remove("is-dragging");
    this.#drag = null;
    for ( const zone of this.element.querySelectorAll(".is-drop-target") ) zone.classList.remove("is-drop-target");
  }

  /**
   * The panel filters: the search box and the item type dropdown.
   *
   * Filtered **client-side with no re-render**, which is the whole point: a re-render per
   * keystroke would rebuild the tile grid, lose the input's focus and caret, and make the box
   * unusable. Both values are kept on the state so they survive a real re-render, and the visible
   * count is rewritten here rather than in Handlebars because a templated number would go stale
   * the moment anything is typed or chosen.
   */
  #wireSearch() {
    for ( const input of this.element.querySelectorAll("[data-shop-search]") ) {
      const key = input.dataset.shopSearch;
      input.value = this.#state.search[key] ?? "";
      if ( this.#firstWiring(input) ) {
        input.addEventListener("input", () => {
          this.#state.search[key] = input.value ?? "";
          this.#applyFilters(key);
        });
      }
    }
    for ( const select of this.element.querySelectorAll("[data-shop-category]") ) {
      const key = select.dataset.shopCategory;
      if ( this.#firstWiring(select) ) {
        select.addEventListener("change", () => {
          this.#state.category[key] = select.value;
          this.#applyFilters(key);
        });
      }
    }
    for ( const key of ["stock", "pack"] ) this.#applyFilters(key);
  }

  /**
   * Elements that already carry this window's listeners.
   *
   * Needed since the coin boxes began re-rendering only the footer: a partial render still runs
   * `_onRender`, but leaves the other parts' elements in place, so wiring them again would stack
   * a second listener on the same box every time a coin was typed.
   * @type {WeakSet<HTMLElement>}
   */
  #wired = new WeakSet();

  /** True the first time an element is seen, false thereafter. */
  #firstWiring(element) {
    if ( this.#wired.has(element) ) return false;
    this.#wired.add(element);
    return true;
  }

  /**
   * Hide the tiles in one panel that match neither filter, and update its count. A tile shows
   * only when it matches **both** the search text and the chosen type.
   * @param {"stock"|"pack"} key
   */
  #applyFilters(key) {
    const panel = this.element.querySelector(`.shop-panel--${key}`);
    if ( !panel ) return;
    const needle = (this.#state.search[key] ?? "").trim().toLowerCase();
    const category = this.#state.category[key] ?? "";

    let shown = 0;
    for ( const tile of panel.querySelectorAll(".shop-tile[data-name]") ) {
      const named = !needle || (tile.dataset.name ?? "").toLowerCase().includes(needle);
      const typed = !category || (tile.dataset.categories ?? "").split(" ").includes(category);
      tile.classList.toggle("is-filtered", !(named && typed));
      if ( named && typed ) shown++;
    }
    const count = panel.querySelector("[data-shop-count]");
    if ( count ) count.textContent = t("shop.showing", { count: shown });
  }

  /**
   * One box per coin on the barter counter.
   *
   * Updated as the player types, not on blur, so the balance in the footer answers "is that
   * enough?" while they are still deciding. That is only possible because the typing never
   * re-renders the part the boxes live in: the footer is re-rendered on its own and the offer
   * total beside the boxes is patched in place, so focus and caret stay put and a player can tab
   * from gold to silver without the boxes being rebuilt under them.
   */
  #wireCoinFields() {
    for ( const box of this.element.querySelectorAll("[data-shop-coin]") ) {
      if ( !this.#firstWiring(box) ) continue;
      box.addEventListener("input", () => {
        const staged = this.#state.setCoin(box.dataset.shopCoin, box.value);
        // Reflect a clamp straight away — typing 12 with 5 in the purse shows 5, rather than
        // leaving a figure on screen that is not what will be offered.
        if ( box.value !== "" && Number(box.value) !== staged ) box.value = staged;
        const offer = this.element.querySelector("[data-shop-offer-total]");
        if ( offer ) offer.textContent = this.#state.totals().offer;
        this.render({ parts: ["footer"] });
      });
    }
  }

  /**
   * The purse picker: pay from the character's own coin or from a Group's.
   *
   * Choosing re-asks the GM for the whole context rather than swapping a figure locally, because
   * the GM is who decides the choice is allowed — and a refusal (ownership revoked, membership
   * gone) falls back to the character's own purse with a notice, instead of leaving the picker
   * showing a purse the deal cannot use.
   *
   * Staged coin is dropped on a switch: coins offered from the party fund are not coins in the
   * character's pocket, and carrying the numbers across would offer the wrong purse's money.
   */
  #wirePayer() {
    const select = this.element.querySelector("[data-shop-payer]");
    if ( !select || !this.#firstWiring(select) ) return;
    select.addEventListener("change", async () => {
      const chosen = select.value === this.#actorId ? "" : select.value;
      if ( chosen === this.#payerId ) return;
      this.#payerId = chosen;
      this.#state.coins = {};
      try {
        await this.refresh();
      } catch ( err ) {
        ui.notifications.warn(err.message);
        this.#payerId = "";
        await this.refresh().catch(() => this.render());
      }
    });
  }

  /**
   * The coin boxes, one per denomination the system defines, each capped at what the character
   * holds of it. A coin the character has none of is still shown, disabled, so the row does not
   * change shape from one character to the next.
   */
  #coinSlots(actor) {
    const currency = actor?.currency ?? {};
    return Object.entries(CONFIG.DND5E?.currencies ?? {}).map(([key, config]) => ({
      key,
      label: config.abbreviation ?? key,
      name: game.i18n.localize(config.label ?? key),
      value: this.#state.coins[key] ?? 0,
      held: Math.max(0, Math.floor(Number(currency[key]) || 0))
    }));
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onUnstageLine(event, target) {
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    const side = target.closest("[data-side]")?.dataset.side;
    if ( !id || !side ) return;
    const step = event.shiftKey ? 5 : 1;
    if ( this.#state.stage(side, id, -step) ) this.render();
  }

  static #onClearCounter() {
    if ( this.#state.empty ) return;
    this.#state.clear();
    this.render();
  }

  static #onSetMode(_event, target) {
    const mode = target.dataset.mode;
    if ( !mode || mode === this.#state.mode ) return;
    this.#state.mode = mode;
    // Coin staged for a barter means nothing in a cash trade, where the net is what changes
    // hands; leaving it set would quietly add it to the next purchase.
    if ( mode !== "barter" ) this.#state.goldCp = 0;
    this.render();
  }

  /** Swap the counter for this character's history with the Trader, and back. */
  static #onToggleHistory() {
    this.#showHistory = !this.#showHistory;
    this.render({ parts: ["topbar", "stage"] });
  }

  /**
   * Haggle: pick a Charisma skill and ask the GM to roll it.
   *
   * The dialog is only a chooser. The check is rolled on the GM's client, which also decides
   * whether the skill is still allowed today and applies the outcome — see trade/haggle.mjs — so a
   * player can pick which way to talk, never how well it went.
   */
  static async #onHaggle() {
    const haggle = this.#state.context?.haggle;
    if ( !haggle || this.#settling ) return;
    const esc = foundry.utils.escapeHTML;
    const first = haggle.skills.find(s => !s.locked)?.key;
    const options = haggle.skills.map(skill => `
      <label class="shop-haggle-skill ${skill.locked ? "is-locked" : ""}">
        <input type="radio" name="haggleSkill" value="${skill.key}"
               ${skill.locked ? "disabled" : ""} ${skill.key === first ? "checked" : ""}>
        <span class="shop-haggle-name">${esc(skill.label)}</span>
        <span class="shop-haggle-mod">${skill.mod >= 0 ? "+" : ""}${skill.mod}</span>
        ${skill.locked ? `<span class="shop-haggle-lock">${t("haggle.locked")}</span>` : ""}
      </label>`).join("");

    const skill = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("haggle.title", { trader: this.#state.context.trader.name }), icon: "fa-solid fa-comments" },
      classes: ["sogrom-shop-dialog"],
      content: `<p>${t("haggle.intro")}</p>
        <p class="shop-haggle-terms">${t("haggle.terms", { dc: haggle.dc, gain: haggle.gain, loss: haggle.loss })}</p>
        ${haggle.edge === "normal" ? "" : `<p class="shop-haggle-edge">${t(`haggle.edge.${haggle.edge}`)}</p>`}
        <fieldset class="shop-haggle-skills"><legend>${t("haggle.skill")}</legend>${options}</fieldset>`,
      ok: {
        label: t("haggle.roll"),
        icon: "fa-solid fa-dice-d20",
        callback: (_event, button) => button.form.elements.haggleSkill?.value
          ?? [...button.form.querySelectorAll("[name=haggleSkill]")].find(i => i.checked)?.value
      },
      rejectClose: false
    });
    if ( !skill ) return;

    try {
      const outcome = await askGM(QUERIES.haggle, { traderId: this.#traderId, actorId: this.#actorId, skill });
      const words = { total: outcome.total, dc: outcome.dc, change: signed(outcome.to - outcome.from).replace(".00", "") };
      if ( outcome.success ) ui.notifications.info(t("haggle.success", words));
      else ui.notifications.warn(t("haggle.failure", words));
    } catch ( err ) {
      ui.notifications.warn(err.message);
    }
    await this.refresh().catch(() => this.render());
  }

  static async #onRefresh() {
    try {
      await this.refresh();
    } catch ( err ) {
      ui.notifications.warn(err.message);
    }
  }

  /**
   * Settle the counter.
   *
   * Sends the intent — ids and quantities only — and lets the GM decide. The button is disabled
   * for the duration, because a double-click would send two settlements and the second would
   * either fail confusingly or succeed twice.
   *
   * On success the context is re-fetched rather than patched locally: the GM has just changed
   * stock, both purses and possibly the attitude, and asking is both simpler and correct.
   */
  static async #onConfirmTrade() {
    if ( this.#settling || this.#state.empty ) return;
    this.#settling = true;
    await this.render();

    try {
      const result = await askGM(QUERIES.trade, {
        traderId: this.#traderId,
        actorId: this.#actorId,
        payerId: this.#payerId || undefined,
        ...this.#state.intent()
      });
      this.#state.clear();
      ui.notifications.info(result.attitudeGained > 0
        ? t("shop.settledWithGoodwill", { points: result.attitudeGained })
        : t("shop.settled"));
    } catch ( err ) {
      // A refusal is normal, not exceptional: someone else bought the last one, the purse moved,
      // a house rule said no. The message is written to be shown to a player.
      ui.notifications.warn(err.message);
      log("settlement refused", err);
    } finally {
      this.#settling = false;
      // Refresh either way. A refusal often means the world moved under the player, and showing
      // them the stale shelf they just failed against would invite the same failure again.
      try {
        await this.refresh();
      } catch {
        await this.render();
      }
    }
  }

  /** Why the confirm button is disabled, for its tooltip. */
  #confirmHint(totals) {
    if ( this.#state.empty ) return t("shop.counterEmpty");
    if ( !totals.accepted ) return t("shop.barterShort", { amount: totals.balance });
    if ( !totals.affordable ) return t("shop.cannotAfford");
    return "";
  }

  /* -------------------------------------------- */

  /** @override */
  async close(options) {
    clearTimeout(this.#refreshTimer);
    const context = this.#state.context;
    ShopApp.#open.delete(`${this.#traderId}:${this.#actorId}`);
    fireHook(HOOKS.shopClosed, { app: this, trader: context?.trader, actor: context?.actor });
    return super.close(options);
  }

  /** @override */
  get title() {
    return this.#state.context?.trader?.name ?? t("shop.title");
  }

  /**
   * Tell every open shop that involves an actor to re-ask for its context.
   *
   * "Involves" means either side: the Trader (the GM restocked, another player bought the last
   * one, the purse changed) or the character (their gold changed, they picked up loot mid-shop).
   * Called from {@link ShopApp.watchWorld}; also usable directly.
   *
   * Debounced per window, because one settlement is a burst of writes — coin, stock, both
   * inventories, attitude — and a round trip to the GM per write would be wasted work that also
   * redraws the window several times in a row. A window mid-confirmation is skipped: it re-asks
   * the moment its own settlement returns anyway.
   *
   * Failures are swallowed per window, so one player's dead socket cannot stop the others.
   * @param {string} actorId
   */
  static refreshFor(actorId) {
    if ( !actorId ) return;
    for ( const app of this.#open.values() ) {
      if ( !app.#involves(actorId) ) continue;
      app.#scheduleRefresh();
    }
  }

  /** Every open shop, re-asked. For changes that touch every price at once, like the preset. */
  static refreshAll() {
    for ( const app of this.#open.values() ) app.#scheduleRefresh();
  }

  /**
   * Keep open shops current as the world changes under them.
   *
   * No socket is needed for this. Foundry sends every Actor, and every Item on it, to every
   * client whatever the ownership — so a player's client sees the Trader's document hooks fire
   * even though it cannot open the Trader's sheet. It only ever uses them as a nudge to ask the
   * GM again: what is actually shown still comes from the GM's context payload.
   *
   * Registered once, at `init`.
   */
  static watchWorld() {
    const actorOf = doc => (doc?.documentName === "Actor" ? doc : doc?.parent);
    const touched = doc => {
      const actor = actorOf(doc);
      if ( actor?.documentName === "Actor" ) ShopApp.refreshFor(actor.id);
    };
    Hooks.on("updateActor", touched);
    for ( const hook of ["createItem", "updateItem", "deleteItem"] ) Hooks.on(hook, touched);
    Hooks.on("updateSetting", setting => {
      if ( setting.key?.startsWith(`${MODULE_ID}.`) ) ShopApp.refreshAll();
    });
  }

  /** Whether this window is a shop for, or at, this actor. */
  #involves(actorId) {
    const context = this.#state.context;
    // The paying Group counts too: another member spending the party fund changes what this
    // player can afford.
    return actorId === this.#actorId || actorId === this.#traderId
      || (!!this.#payerId && actorId === this.#payerId)
      || actorId === context?.trader?.id || actorId === context?.actor?.id;
  }

  /** The pending debounced refresh, if any. */
  #refreshTimer = null;

  /** How long a burst of writes has to go quiet before an open shop re-asks, in milliseconds. */
  static REFRESH_DEBOUNCE = 200;

  #scheduleRefresh() {
    if ( this.#settling ) return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      if ( this.#settling || !ShopApp.#open.has(`${this.#traderId}:${this.#actorId}`) ) return;
      this.refresh().catch(err => log("shop refresh failed", err));
    }, ShopApp.REFRESH_DEBOUNCE);
  }

  /** Every open shop, for the API and the harness. */
  static get instances() {
    return [...this.#open.values()];
  }
}

/* -------------------------------------------- */

/**
 * The character a shop should open for.
 *
 * A GM may name any actor; a player gets their assigned character. Falling back to "the only
 * character they own" would be convenient and wrong — a player who owns two characters would
 * silently shop as whichever came first in the collection.
 * @param {object|string} [actor]
 * @returns {object|null}
 */
function resolveCharacter(actor) {
  if ( actor && typeof actor === "object" ) return actor;
  if ( typeof actor === "string" ) return game.actors.get(actor) ?? null;
  return game.user.character ?? null;
}
