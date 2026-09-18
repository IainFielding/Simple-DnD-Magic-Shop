/**
 * Do the windows actually render?
 *
 * Nothing else in this harness opens one. The unit tests never touch a template, the syntax and
 * localisation checks cannot see inside a `.hbs`, and every other suite calls the data layer
 * directly — so until this file existed, a broken Handlebars expression, a missing partial or a
 * renamed context field would have sailed through every gate and landed in front of a player.
 *
 * Deliberately shallow. This is not a UI test: it asserts that each window renders without
 * throwing and that the landmarks a person would look for are on screen. What the pixels look
 * like is a job for eyes.
 */

const MODULE = "sogrom-simple-dnd5e-magic-shop";
const PREFIX = "[e2e]";

class Report {
  cases = [];

  check(name, condition, detail = "") {
    this.cases.push({ name, pass: !!condition, detail: condition ? "" : String(detail) });
    return !!condition;
  }

  fail(name, err) {
    this.cases.push({ name, pass: false, detail: `${err?.message ?? err}\n${err?.stack ?? ""}` });
  }

  get summary() {
    return { total: this.cases.length, failed: this.cases.filter(c => !c.pass).length, cases: this.cases };
  }
}

/** Let a render settle. ApplicationV2 renders asynchronously through several awaits. */
const settle = () => new Promise(resolve => setTimeout(resolve, 250));

/** A double-click, which is what puts an item on the counter now that a single click does nothing. */
const doubleClick = element => element?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

/* -------------------------------------------- */

/**
 * Open the Trader Manager on each of its four tabs.
 *
 * Every tab is visited because each builds its own context and its own branch of the template —
 * a fault in the Attitudes table is invisible while the Identity tab is showing.
 */
export async function managerSuite() {
  const report = new Report();
  const api = game.modules.get(MODULE)?.api;
  let trader = null;
  let app = null;

  try {
    trader = await api.createTrader({ name: `${PREFIX} Render`, greeting: "Mind the cauldron." });
    await trader.update({ "system.currency": { pp: 0, gp: 250, ep: 0, sp: 0, cp: 0 } });
    await trader.createEmbeddedDocuments("Item", [{
      name: `${PREFIX} Shelf Item`,
      type: "loot",
      system: { quantity: 2, price: { value: 8, denomination: "gp" }, rarity: "rare" },
      flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 2 } }
    }]);

    app = api.openManager();
    await settle();

    const root = app.element;
    if ( !report.check("the manager renders an element", !!root) ) return report.summary;

    // Select *this suite's* Trader explicitly. The manager opens on whichever Trader is first in
    // the rail, and the test world is also where GMs make their own by hand — so without this the
    // assertions below were quietly inspecting somebody's empty "New Trader" and reporting that
    // its name and stock were wrong.
    const own = root.querySelector(`[data-trader-id="${trader.id}"] [data-action="selectTrader"]`);
    if ( !report.check("the suite's own Trader is in the rail", !!own) ) return report.summary;
    own.click();
    await settle();

    const overlap = railOverlap(root);
    report.check("no two Traders in the rail overlap", !overlap, overlap);

    report.check("its chrome is present", !!root.querySelector(".shop-topbar"));
    report.check("the Trader rail is present", !!root.querySelector(".shop-rail"));
    report.check("the new Trader is listed",
      root.textContent.includes(`${PREFIX} Render`), root.textContent.slice(0, 200));
    report.check("no raw localisation key leaked into the markup",
      !root.textContent.includes(MODULE),
      rawKeys(root));

    /*
     * Each tab is asserted to have rendered real *controls*, not merely a panel.
     *
     * "A panel rendered" is exactly what a context-nesting bug still does: the markup is
     * perfect and the `{{#each}}` inside it silently iterates nothing. That has now happened
     * three times — the generator, the kind picker, and the Trading and Attitudes panes — every
     * one of them invisible to syntax, lint, JSON and localisation checks. So every tab names
     * something that can only exist if its context actually arrived.
     */
    const tabExpectations = {
      identity: [
        ["the name field carries the Trader's name",
          el => el.querySelector('[data-shop-field="name"]')?.value?.includes(PREFIX)],
        ["the purse offers a slot per denomination",
          el => el.querySelectorAll('[data-shop-field="currency"]').length >= 3],
        ["the archetype picker lists the built-ins",
          el => el.querySelectorAll('[data-shop-field="view.archetype"] option').length >= 7],
        ["and spells the chosen archetype out before it is applied",
          el => el.querySelectorAll(".shop-archetype-facts dd").length === 5
            && [...el.querySelectorAll(".shop-archetype-facts dd")].every(dd => dd.textContent.trim())]
      ],
      stock: [
        ["the stock table has a row for the stocked item",
          el => el.querySelectorAll(".shop-stock-table tbody tr[data-item-id]").length > 0],
        ["each row offers a quantity and a price override",
          el => !!el.querySelector('[data-shop-field="quantity"]')
            && !!el.querySelector('[data-shop-field="overrideValue"]')],
        // "Buys / sells", from the Trader's side like the shop: what it pays comes first and
        // must be the smaller figure. Compared in raw copper from the data attributes.
        ["the price column reads buys-then-sells, lower first",
          el => {
            const buys = Number(el.querySelector(".shop-preview-buys")?.dataset.cp);
            const sells = Number(el.querySelector(".shop-preview-sells")?.dataset.cp);
            return buys > 0 && sells > 0 && buys < sells;
          }]
      ],
      trading: [
        ["the buy filter is on by default, which needs its context to have resolved",
          el => el.querySelector('[data-shop-field="allowAll"]')?.checked === true],
        ["the restock dropdown is populated",
          el => el.querySelectorAll('[data-shop-field="restockMode"] option').length >= 3],
        ["the goodwill override is offered",
          el => !!el.querySelector('[data-shop-field="gainCustom"]')]
      ],
      ledger: [
        ["a Trader that has not traded shows the empty ledger",
          el => !!el.querySelector(".shop-ledger .shop-empty")]
      ],
      attitudes: [
        ["a row per player character",
          el => el.querySelectorAll("tr[data-character-id]").length > 0],
        ["each with a slider to set the attitude",
          el => !!el.querySelector('[data-shop-field="attitude"]')],
        ["the multipliers read buys-then-sells, lower first, on every row",
          el => [...el.querySelectorAll("tr[data-character-id]")].every(row => {
            const figure = cls => Number(
              row.querySelector(cls)?.textContent.replace(/[^\d.]/g, ""));
            const buys = figure(".shop-preview-buys");
            const sells = figure(".shop-preview-sells");
            return buys > 0 && sells > 0 && buys < sells;
          })]
      ]
    };

    for ( const [tab, expectations] of Object.entries(tabExpectations) ) {
      const button = root.querySelector(`[data-action="selectTab"][data-tab="${tab}"]`);
      if ( !report.check(`the ${tab} tab has a button`, !!button) ) continue;
      button.click();
      await settle();

      const panel = app.element.querySelector("[role='tabpanel']");
      if ( !report.check(`the ${tab} tab renders a panel`, !!panel) ) continue;
      report.check(`the ${tab} tab leaks no raw keys`,
        !app.element.textContent.includes(MODULE), rawKeys(app.element));

      for ( const [what, test] of expectations ) {
        // A throwing predicate is a failure, not a crash: an expectation that reaches into a
        // context field that never arrived should report the tab as broken, not take the run
        // down with it.
        let passed = false;
        try {
          passed = !!test(app.element);
        } catch {
          passed = false;
        }
        report.check(`${tab}: ${what}`, passed,
          "the markup rendered but its context did not arrive");
      }
    }

    // Unticking "buys anything" must reveal the lists it hides — the one interaction on the
    // Trading tab that changes what is on screen.
    root.querySelector('[data-action="selectTab"][data-tab="trading"]')?.click();
    await settle();
    const allowAll = app.element.querySelector('[data-shop-field="allowAll"]');
    if ( report.check("the buy filter has an allow-all toggle", !!allowAll) ) {
      allowAll.checked = false;
      allowAll.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      report.check("unticking it reveals the item-type list",
        app.element.querySelectorAll('[data-shop-field="filterType"]').length > 0,
        "the type list rendered empty");
      report.check("and the rarity list",
        app.element.querySelectorAll('[data-shop-field="filterRarity"]').length > 0,
        "the rarity list rendered empty");

      const restore = app.element.querySelector('[data-shop-field="allowAll"]');
      restore.checked = true;
      restore.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    }

    // The Stock tab's generator builds the whole compendium pool, which is the slowest and most
    // failure-prone thing the manager does.
    root.querySelector('[data-action="selectTab"][data-tab="stock"]')?.click();
    await settle();
    const generate = app.element.querySelector('[data-action="toggleGenerator"]');
    if ( report.check("the generator has a toggle", !!generate) ) {
      generate.click();
      await new Promise(resolve => setTimeout(resolve, 2500));   // the pool walks every pack
      report.check("the generator panel renders",
        !!app.element.querySelector(".shop-generator"),
        "no .shop-generator after toggling");

      // Every control in the panel is asserted to have actually produced *rows*, not merely to
      // exist. This is the shape of bug that keeps getting through: a template reading a context
      // key at the wrong nesting level renders the surrounding markup perfectly and fills it
      // with nothing, which no syntax, lint, JSON or localisation check can see. An empty
      // `{{#each}}` is silent by design, so it has to be asserted against explicitly.
      const rows = selector => app.element.querySelectorAll(selector).length;

      report.check("the rarity buckets have inputs",
        rows(".shop-generator-bucket input") > 0, "no rarity inputs");
      report.check("the kind picker has checkboxes to tick",
        rows('.shop-generator-kinds input[type="checkbox"]') > 0,
        "the kinds picker rendered with nothing in it");
      report.check("the kind picker groups them by item type",
        rows(".shop-kind-group") > 0, "no kind groups");
      report.check("and offers subtypes beneath at least one type",
        rows(".shop-kind-subs input") > 0,
        "no subtypes — armour and musical instruments would be unreachable");
      report.check("the compendium picker has sources to tick",
        rows('.shop-generator-packs input[type="checkbox"]') > 0,
        "the sources picker rendered with nothing in it");
      report.check("the price ceiling and its denomination render",
        !!app.element.querySelector('[data-shop-field="gen.maxValue"]')
        && rows('[data-shop-field="gen.maxDenom"] option') > 0);
      report.check("the run button is enabled by the default budget",
        app.element.querySelector('[data-action="generateStock"]')?.disabled === false,
        "the generate button was disabled with a non-empty default budget");

      // Ticking a filter re-renders the pane to update the counts, which used to slam shut the
      // very list being ticked through — a `<details>` keeps its open state in the DOM and
      // nowhere else, so rebuilding the markup closed it.
      const sources = app.element.querySelector('[data-shop-details="sources"]');
      if ( report.check("the compendium block is collapsible", !!sources) ) {
        sources.open = true;
        const box = sources.querySelector('input[type="checkbox"][data-pack]');

        if ( report.check("it has a compendium to tick", !!box) ) {
          const pack = box.dataset.pack;
          box.checked = true;
          box.dispatchEvent(new Event("change", { bubbles: true }));
          await settle();

          const after = app.element.querySelector('[data-shop-details="sources"]');
          report.check("ticking a compendium leaves the block open",
            after?.open === true, "the block collapsed on the re-render");
          report.check("and the tick survives the re-render",
            after?.querySelector(`input[data-pack="${CSS.escape(pack)}"]`)?.checked === true,
            "the checkbox came back unticked");
          report.check("and the focus is handed back to it",
            app.element.ownerDocument.activeElement?.dataset?.pack === pack,
            `focus went to ${app.element.ownerDocument.activeElement?.tagName}`);

          // Put it back, so the later assertions see an unnarrowed pool.
          const restore = app.element.querySelector(`input[data-pack="${CSS.escape(pack)}"]`);
          restore.checked = false;
          restore.dispatchEvent(new Event("change", { bubbles: true }));
          await settle();
        }
      }
    }
  } catch ( err ) {
    report.fail("managerSuite threw", err);
  } finally {
    await app?.close().catch(() => {});
    if ( trader ) await trader.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */

/**
 * Open a shop, stage something, switch to barter, and make sure it all draws.
 *
 * Run once per display mode. The two are genuinely different layouts — an unframed element
 * covering the viewport, versus the same parts inside Foundry's own window chrome — and the
 * grid that arranges them is keyed off a different selector in each. Testing only the default
 * would leave whichever mode is not the default to rot, and the default has already been
 * flipped once.
 * @param {"windowed"|"fullscreen"} [mode]
 */
export async function shopSuite(mode = "windowed") {
  const report = new Report();
  const api = game.modules.get(MODULE)?.api;
  let trader = null;
  let app = null;
  let restore = null;
  let cloak = null;

  try {
    // Set before the window is constructed: the shell reads the setting in its constructor, so
    // changing it afterwards would have no effect on a window that is already up.
    restore = game.settings.get(MODULE, "displayMode");
    await game.settings.set(MODULE, "displayMode", mode);
    report.check(`[${mode}] the display mode is set`,
      game.settings.get(MODULE, "displayMode") === mode);

    trader = await api.createTrader({ name: `${PREFIX} Shopfront` });
    await trader.update({ "system.currency": { pp: 0, gp: 250, ep: 0, sp: 0, cp: 0 } });
    await trader.createEmbeddedDocuments("Item", [
      {
        name: `${PREFIX} Cheap Thing`,
        type: "loot",
        system: { quantity: 4, price: { value: 2, denomination: "gp" } },
        flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 4 } }
      },
      {
        name: `${PREFIX} Rare Thing`,
        type: "loot",
        system: { quantity: 1, price: { value: 30, denomination: "gp" }, rarity: "veryRare" },
        flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 1 } }
      }
    ]);

    const character = game.actors.find(a => a.name === `${PREFIX} Thog`);
    if ( !report.check("a shopper exists", !!character) ) return report.summary;

    // Something the shopper is wearing and attuned to, so the pack can be seen to say so.
    [cloak] = await character.createEmbeddedDocuments("Item", [{
      name: `${PREFIX} Worn Cloak`,
      type: "equipment",
      system: {
        quantity: 1, price: { value: 40, denomination: "gp" }, equipped: true,
        attunement: "required", attuned: true, properties: ["mgc"], rarity: "uncommon", type: { value: "clothing" }
      }
    }]);

    app = await api.openShop(trader.id, { actor: character });
    await settle();

    const root = app?.element;
    if ( !report.check("the shop renders an element", !!root) ) return report.summary;

    // The one thing that genuinely differs between the modes, asserted rather than assumed.
    if ( mode === "fullscreen" ) {
      report.check("fullscreen renders unframed",
        root.classList.contains("sogrom-shop-fullscreen"), [...root.classList].join(" "));
      report.check("and supplies its own close control",
        !!root.querySelector('[data-action="closeShell"]'));
    } else {
      report.check("windowed renders inside Foundry's frame",
        root.classList.contains("sogrom-shop-windowed"), [...root.classList].join(" "));
      report.check("and leaves the close control to Foundry",
        !root.querySelector('[data-action="closeShell"]'),
        "the shell drew a second close button inside a framed window");
      report.check("and the grid is applied to the window content",
        !!root.querySelector(".window-content .shop-panel--stage"));
    }

    report.check("the chrome is present", !!root.querySelector(".shop-topbar--shop"));
    report.check("the attitude meter is present", !!root.querySelector(".shop-attitude-track"));

    // Both portraits at their full size — measured, because an image in a flex row is exactly the
    // thing that quietly shrinks when a neighbour needs the room.
    const portraits = [...root.querySelectorAll(".shop-party-img")].map(img => {
      const rect = img.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    });
    report.check("both portraits are shown at 204x204",
      portraits.length === 2 && portraits.every(size => size === "204x204"),
      `portraits measure ${portraits.join(", ") || "nothing"}`);

    // The portraits set the bar's height, and every pixel of it comes out of the shelves. It was
    // cut by 30% (from ~325px) to give the stock more room; keep it there.
    const barHeight = Math.round(root.querySelector(".shop-topbar--shop")?.getBoundingClientRect().height ?? 0);
    report.check("the top bar stays short enough to leave the shelves their room",
      barHeight > 0 && barHeight <= 240, `the top bar is ${barHeight}px tall`);

    // The rate line is worded from the Trader's side — it buys your goods low and sells to you
    // high — so the "buying" figure must be the smaller one. Asserted on the relationship rather
    // than exact values, because the no-arbitrage rule guarantees it for every character at
    // every Trader, and it is the thing that was once shown the wrong way round.
    const rate = root.querySelector(".shop-rate")?.textContent ?? "";
    const figures = [...rate.matchAll(/x\s*([\d.]+)/g)].map(m => Number(m[1]));
    report.check("the rate line shows two multipliers", figures.length === 2, rate.trim());
    report.check("and the Trader buys lower than it sells",
      figures.length === 2 && figures[0] < figures[1],
      `rate line reads "${rate.trim()}"`);
    report.check("the counter is present", !!root.querySelector(".shop-panel--stage"));
    report.check("the footer is present", !!root.querySelector(".shop-footer"));

    // The history toggle swaps the counter for the character's dealings and back, without
    // losing the counter itself.
    root.querySelector('[data-action="toggleHistory"]')?.click();
    await settle();
    report.check("the history toggle shows this character's dealings in place of the counter",
      !!app.element.querySelector(".shop-panel--stage .shop-history")
        && !app.element.querySelector(".shop-panel--stage [data-shop-offer-total]"));
    report.check("an untraded character is told so",
      !!app.element.querySelector(".shop-history .shop-stage-empty"));
    app.element.querySelector('[data-action="toggleHistory"]')?.click();
    await settle();
    report.check("and toggling again brings the counter back",
      !!app.element.querySelector(".shop-panel--stage [data-shop-offer-total]"));
    report.check("a character in no Group is offered no purse choice",
      !app.element.querySelector("[data-shop-payer]"));
    report.check("no raw localisation key leaked into the markup",
      !root.textContent.includes(MODULE), rawKeys(root));

    // The panel order is a deliberate decision — your pack on the left, their shelves on the
    // right — and it is set by the order the parts are declared, which is easy to undo by
    // accident when adding a part.
    const panels = [...root.querySelectorAll(".shop-panel")];
    const order = panels.map(panel =>
      panel.classList.contains("shop-panel--pack") ? "pack"
        : panel.classList.contains("shop-panel--stage") ? "stage"
          : "stock");
    report.check("the panels run pack, counter, stock from left to right",
      JSON.stringify(order) === JSON.stringify(["pack", "stage", "stock"]),
      order.join(" -> "));

    const tiles = root.querySelectorAll(".shop-panel--stock .shop-tile");
    report.check("the shelves render tiles", tiles.length === 2, `${tiles.length} tiles`);

    // Icon-only tiles: a name or price rendered under the box would put the layout back.
    report.check("tiles carry no name or price text",
      !root.querySelector(".shop-tile-name") && !root.querySelector(".shop-tile-price"));
    report.check("but keep the name for search and screen readers",
      [...tiles].every(tile => !!tile.dataset.name && !!tile.querySelector("[aria-label]")));

    // The icon must fit its box — measured, not eyeballed.
    //
    // This is here because it went wrong: the icon was a centred grid item sized `height: 100%`
    // against a row whose height came from the icon, and that circular percentage resolves to
    // the image's intrinsic size. Foundry item icons are routinely 512px, so they rendered far
    // larger than the tiles they were supposed to sit in. A rule that *looks* right and is not
    // deserves a measurement rather than another opinion.
    const box = tiles[0]?.querySelector(".shop-tile-button")?.getBoundingClientRect();
    const icon = tiles[0]?.querySelector(".shop-tile-img")?.getBoundingClientRect();
    if ( report.check("a tile has a box and an icon", !!box && !!icon) ) {
      report.check("the tile box is the configured size",
        Math.round(box.width) === Math.round(box.height) && box.width >= 48 && box.width <= 96,
        `box is ${Math.round(box.width)}x${Math.round(box.height)}`);
      report.check("the icon fits inside its box rather than overflowing it",
        icon.width <= box.width + 1 && icon.height <= box.height + 1,
        `icon ${Math.round(icon.width)}x${Math.round(icon.height)} `
          + `in a ${Math.round(box.width)}x${Math.round(box.height)} box`);
      report.check("and the icon is actually visible rather than collapsed",
        icon.width > 16 && icon.height > 16,
        `icon is ${Math.round(icon.width)}x${Math.round(icon.height)}`);
    }

    // The staging columns must not resize with their contents — a layout that reflows while you
    // are clicking moves the thing you were about to click next.
    //
    // Measured on the two **inner** columns, not on the counter as a whole. The counter's outer
    // width is pinned by the window's own grid, so measuring that passed happily while the two
    // halves inside it were visibly different sizes. Measure the thing that was moving.
    const columnWidths = () => [...app.element.querySelectorAll(".shop-stage-col")]
      .map(col => Math.round(col.getBoundingClientRect().width));
    const widthsBefore = columnWidths();

    report.check("the counter has two columns", widthsBefore.length === 2,
      `found ${widthsBefore.length}`);
    report.check("which start out the same width",
      widthsBefore[0] === widthsBefore[1], widthsBefore.join(" vs "));

    // A single click does nothing; a double-click stages one. Make sure the counter and footer follow.
    const button = tiles[0]?.querySelector(".shop-tile-button");
    if ( report.check("a tile has a button", !!button) ) {
      button.click();
      await settle();
      report.check("a single click on a tile leaves the counter alone",
        !app.element.querySelector(".shop-staged-row"));
      doubleClick(button);
      await settle();
      report.check("double-clicking a tile puts a row on the counter",
        !!app.element.querySelector(".shop-staged-row"));
      report.check("and the footer shows what is owed",
        !!app.element.querySelector(".shop-balance .shop-coin"));
      report.check("and the confirm button is enabled",
        app.element.querySelector(".shop-confirm")?.disabled === false);
      const widthsAfter = columnWidths();
      report.check("staging does not change the counter's column widths",
        widthsAfter.join() === widthsBefore.join(),
        `columns went ${widthsBefore.join("/")} -> ${widthsAfter.join("/")} when a row landed`);
      report.check("and the two columns are still equal",
        widthsAfter[0] === widthsAfter[1], widthsAfter.join(" vs "));
    }

    // The counter's columns mirror the panels either side: give on the left next to your pack,
    // take on the right next to their shelves, so nothing crosses the window.
    const headings = [...app.element.querySelectorAll(".shop-panel-head--stage h2")]
      .map(h => h.textContent.trim().toLowerCase());
    report.check("the counter reads give then take, matching the panels either side",
      headings.length === 2 && headings[0].includes("give") && headings[1].includes("take"),
      headings.join(" | "));

    // The right-click menu, double-click to take back, and dragging.
    //
    // Exercised on the one-off item on purpose. Staging its only unit exhausts the line, and
    // exhaustion used to disable the tile; a disabled button gets no mouse events, so the menu
    // that should put it back would never open on exactly this tile.
    // Foundry animates its menu shut for 200ms and only then removes it — and removes whichever
    // menu element it holds at that moment. A right-click that opens the next menu before the last
    // one has finished closing has that new menu removed out from under it. So every right-click
    // here first waits for the previous menu to be gone, then for its own to appear.
    const menuOpen = () => !!document.querySelector("#context-menu");
    const until = async (test, ms = 2000) => {
      for ( const end = Date.now() + ms; !test() && Date.now() < end; ) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const rightClick = async element => {
      await until(() => !menuOpen());
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
      element.dispatchEvent(event);
      return event;
    };
    // Foundry draws the menu as `#context-menu` on the page, not inside the window.
    const menuLabels = () => [...document.querySelectorAll("#context-menu .context-item")]
      .map(item => item.textContent.trim());
    const pickFromMenu = async label => {
      const entry = [...document.querySelectorAll("#context-menu .context-item")]
        .find(item => item.textContent.trim() === label);
      entry?.click();
      await until(() => !menuOpen());
      await settle();
      return !!entry;
    };
    const closeMenu = async () => {
      ui.context?.close();
      await until(() => !menuOpen());
    };
    const rareTile = () => [...app.element.querySelectorAll(".shop-panel--stock .shop-tile")]
      .find(tile => tile.dataset.name?.includes("Rare Thing"));
    const rareRow = () => [...app.element.querySelectorAll(".shop-staged-row")]
      .find(row => row.textContent.includes("Rare Thing"));
    const menuText = key => game.i18n.localize(`${MODULE}.shop.menu.${key}`);

    const rare = rareTile();
    if ( report.check("the one-off item has a tile", !!rare) ) {
      report.check("and knows which compendium entry to show", !!rare.dataset.sourceUuid,
        "the tile carries no data-source-uuid");

      await rightClick(rare.querySelector(".shop-tile-button"));
      await until(menuOpen);
      report.check("right-clicking a tile opens a menu offering to add it and to view it",
        menuLabels().includes(menuText("addOne")) && menuLabels().includes(menuText("view")),
        menuLabels().join(" | "));
      report.check("but not to take back what is not on the counter",
        !menuLabels().includes(menuText("removeOne")), menuLabels().join(" | "));
      report.check("and not 'several' of a line that has only one",
        !menuLabels().includes(menuText("addSome")), menuLabels().join(" | "));
      await pickFromMenu(menuText("addOne"));
      report.check("choosing 'put one on the counter' stages it", !!rareRow());
      report.check("and leaves its tile enabled rather than disabled",
        rareTile()?.querySelector(".shop-tile-button")?.disabled === false,
        "the exhausted tile was disabled, so the menu could not reach it");

      await rightClick(rareTile().querySelector(".shop-tile-button"));
      await until(menuOpen);
      report.check("the exhausted tile's menu offers to take it back, not to add more",
        menuLabels().includes(menuText("removeOne")) && !menuLabels().includes(menuText("addOne")),
        menuLabels().join(" | "));
      await pickFromMenu(menuText("removeOne"));
      report.check("choosing 'take one back' takes it off the counter", !rareRow());

      // Double-click the tile on, then double-click the counter row off.
      doubleClick(rareTile().querySelector(".shop-tile-button"));
      await settle();
      if ( report.check("double-clicking puts it back on the counter", !!rareRow()) ) {
        doubleClick(rareRow().querySelector(".shop-staged-name"));
        await settle();
        report.check("double-clicking the counter row takes it back", !rareRow());
      }

      // The counter row has the same menu.
      doubleClick(rareTile().querySelector(".shop-tile-button"));
      await settle();
      if ( rareRow() ) {
        await rightClick(rareRow());
        await until(menuOpen);
        report.check("right-clicking a counter row offers to take it back and to view it",
          menuLabels().includes(menuText("removeOne")) && menuLabels().includes(menuText("view")),
          menuLabels().join(" | "));
        await pickFromMenu(menuText("removeOne"));
        report.check("and taking it back from there works too", !rareRow());
      }

      // "View item" opens the compendium entry, as the receipt's link does.
      await rightClick(rareTile().querySelector(".shop-tile-button"));
      await until(menuOpen);
      const expected = rareTile().dataset.sourceUuid;
      const before = new Set(foundry.applications.instances.keys());
      await pickFromMenu(menuText("view"));
      await new Promise(resolve => setTimeout(resolve, 600));
      const opened = [...foundry.applications.instances.values()].filter(a => !before.has(a.id));
      const sheet = opened.find(a => a.document?.uuid === expected);
      report.check("'View item' opens the item's own entry", !!sheet,
        `expected ${expected}; opened ${opened.map(a => a.document?.uuid ?? a.id).join(", ") || "nothing"}`);
      for ( const extra of opened ) await extra.close().catch(() => {});

      // Right-clicking something that is not an item opens no menu and leaves the counter alone.
      //
      // Not asserted on `defaultPrevented`: Foundry itself calls `preventDefault()` on every
      // `contextmenu` event in the game (client/game.mjs), so that check could never fail.
      doubleClick(rareTile().querySelector(".shop-tile-button"));
      await settle();
      await rightClick(app.element.querySelector(".shop-panel-head"));
      await settle();
      report.check("right-clicking outside an item opens no menu", !menuLabels().length,
        menuLabels().join(" | "));
      report.check("and leaves the counter alone", !!rareRow(),
        "a right-click on a panel heading took an item off the counter");
      await closeMenu();

      // Dragging: a counter row back onto its shelf takes the line back; a tile onto the counter
      // stages it. Synthetic drag events carry a real DataTransfer, which is all the handlers read.
      const drag = async (from, to) => {
        const dataTransfer = new DataTransfer();
        const fire = (element, type) => element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
        fire(from, "dragstart");
        fire(to, "dragover");
        const highlighted = to.closest(".shop-panel")?.classList.contains("is-drop-target");
        fire(to, "drop");
        fire(from, "dragend");
        await settle();
        return highlighted;
      };
      if ( rareRow() ) {
        const lit = await drag(rareRow(), app.element.querySelector(".shop-panel--stock .shop-panel-body"));
        report.check("dragging a counter row over its shelf lights the shelf up", lit);
        report.check("and dropping it there takes it back off the counter", !rareRow());
      }
      const litCounter = await drag(rareTile().querySelector(".shop-tile-button"),
        app.element.querySelector(".shop-panel--stage .shop-panel-body"));
      report.check("dragging a tile over the counter lights the counter up", litCounter);
      report.check("and dropping it there puts it on the counter", !!rareRow());
      report.check("and leaves no drop highlight behind",
        !app.element.querySelector(".is-drop-target, .is-dragging"));

      if ( rareRow() ) {
        await drag(rareRow(), app.element.querySelector(".shop-panel--pack .shop-panel-body"));
        report.check("a row of something being bought cannot be dropped on the character's pack", !!rareRow());
        doubleClick(rareRow().querySelector(".shop-staged-name"));
        await settle();
      }
    }

    // Barter renders a different footer and an extra field.
    app.element.querySelector('[data-action="setMode"][data-mode="barter"]')?.click();
    await settle();
    const boxes = [...app.element.querySelectorAll("[data-shop-coin]")];
    report.check("barter mode offers a box per coin", boxes.length === 5,
      `found ${boxes.length} coin boxes`);

    // Typing a coin must update the offer and the footer *without* rebuilding the box being typed
    // in — otherwise focus and caret are lost on every keystroke and tabbing between coins breaks.
    const coinBox = boxes.find(b => !b.disabled);
    if ( report.check("at least one coin coinBox is usable", !!coinBox) ) {
      const coin = coinBox.dataset.shopCoin;
      const offerBefore = app.element.querySelector("[data-shop-offer-total]")?.textContent.trim();
      coinBox.focus();
      coinBox.value = "1";
      coinBox.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();

      const same = app.element.querySelector(`[data-shop-coin="${coin}"]`);
      report.check("typing a coin keeps the same coinBox in place", same === coinBox && coinBox.isConnected);
      report.check("and keeps the focus in it",
        app.element.ownerDocument.activeElement === coinBox,
        `focus went to ${app.element.ownerDocument.activeElement?.tagName}`);
      report.check("and updates the offer total beside it",
        app.element.querySelector("[data-shop-offer-total]")?.textContent.trim() !== offerBefore);

      // A figure above the purse is clamped in the coinBox itself, not only at settlement.
      coinBox.value = "999999999";
      coinBox.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      report.check("an amount above the purse is clamped in the coinBox",
        Number(coinBox.value) < 999999999 && Number(coinBox.value) <= Number(coinBox.max),
        `coinBox reads ${coinBox.value} with max ${coinBox.max}`);
    }

    // The world changing under an open shop. A GM restocking a shelf — or another player buying
    // from it — must show up without the player pressing refresh, and must not throw away what
    // they have staged or the box they are typing in.
    const cheapBadge = () => [...app.element.querySelectorAll(".shop-panel--stock .shop-tile")]
      .find(tile => tile.dataset.name?.includes("Cheap Thing"))
      ?.querySelector(".shop-tile-badge")?.textContent.trim();
    const stagedBefore = app.element.querySelectorAll(".shop-staged-row").length;
    const focusedCoin = app.element.ownerDocument.activeElement?.dataset?.shopCoin;
    const coinValue = focusedCoin
      ? app.element.querySelector(`[data-shop-coin="${focusedCoin}"]`)?.value : null;

    await trader.items.find(i => i.name.includes("Cheap Thing")).update({ "system.quantity": 9 });
    await new Promise(resolve => setTimeout(resolve, 900));

    report.check("an open shop picks up a stock change without being refreshed by hand",
      cheapBadge() === "9", `the tile's badge reads ${cheapBadge()}`);
    report.check("and keeps what was staged",
      app.element.querySelectorAll(".shop-staged-row").length === stagedBefore,
      `staged rows went ${stagedBefore} -> ${app.element.querySelectorAll(".shop-staged-row").length}`);
    if ( report.check("a coin box had the focus before the change", !!focusedCoin) ) {
      const box = app.element.querySelector(`[data-shop-coin="${focusedCoin}"]`);
      report.check("and the focus is put back in it after the refresh",
        app.element.ownerDocument.activeElement === box,
        `focus is on ${app.element.ownerDocument.activeElement?.outerHTML?.slice(0, 80)}`);
      report.check("with the amount still in it", box?.value === coinValue,
        `box reads ${box?.value}, was ${coinValue}`);
    }

    /* --- Item state, price breakdown and haggling ------------------------ */
    const cloakTile = [...app.element.querySelectorAll(".shop-panel--pack .shop-tile")]
      .find(tile => tile.dataset.name?.includes("Worn Cloak"));
    if ( report.check("the worn cloak is in the pack", !!cloakTile) ) {
      report.check("its tile shows it is equipped", !!cloakTile.querySelector(".shop-tile-status .fa-shield-halved"));
      report.check("and attuned", !!cloakTile.querySelector(".shop-tile-status .fa-sun"));
      const label = cloakTile.querySelector(".shop-tile-button")?.getAttribute("aria-label") ?? "";
      report.check("and says so in words, not only icons", /Equipped/.test(label) && /Attuned/.test(label), label);

      doubleClick(cloakTile.querySelector(".shop-tile-button"));
      await settle();
      const row = app.element.querySelector('.shop-staged-row[data-side="give"]');
      report.check("staging it warns the state will not go with it", !!row?.querySelector(".shop-staged-status"),
        row?.outerHTML?.slice(0, 200));
      report.check("and its price explains itself on hover",
        (row?.querySelector(".shop-staged-line")?.dataset.tooltip ?? "").includes("<table"));
    }
    report.check("the rate line carries the price breakdown",
      (app.element.querySelector(".shop-rate")?.dataset.tooltip ?? "").includes("<table"));
    report.check("there is a Haggle button", !!app.element.querySelector('[data-action="haggle"]'));

    report.check("and still leaks no raw keys",
      !app.element.textContent.includes(MODULE), rawKeys(app.element));
  } catch ( err ) {
    report.fail(`shopSuite (${mode}) threw`, err);
  } finally {
    await app?.close().catch(() => {});
    if ( cloak ) await cloak.delete().catch(() => {});
    if ( trader ) await trader.delete().catch(() => {});
    if ( restore !== null ) await game.settings.set(MODULE, "displayMode", restore);
  }

  // Prefix every case with the mode, so a failure says which layout broke.
  for ( const item of report.cases ) {
    if ( !item.name.startsWith(`[${mode}]`) ) item.name = `[${mode}] ${item.name}`;
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  The item type filter                        */
/* -------------------------------------------- */

/**
 * The type dropdown on each panel: it lists only what the panel holds, filters without a
 * re-render, combines with the search box, and lets go of a type that has sold out.
 */
export async function typeFilterSuite() {
  const report = new Report();
  const api = game.modules.get(MODULE)?.api;
  let trader = null;
  let app = null;

  const line = (name, type, subtype, gp) => ({
    name: `${PREFIX} ${name}`, type,
    system: { quantity: 2, price: { value: gp, denomination: "gp" }, type: { value: subtype } },
    flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 2 } }
  });

  try {
    trader = await api.createTrader({ name: `${PREFIX} Filter Stall` });
    await trader.createEmbeddedDocuments("Item", [
      line("Dagger", "weapon", "simpleM", 2),
      line("Longsword", "weapon", "martialM", 15),
      line("Plate", "equipment", "heavy", 1500),
      line("Ruby", "loot", "gem", 50)
    ]);
    const character = game.actors.find(a => a.name === `${PREFIX} Thog`);
    app = await api.openShop(trader.id, { actor: character });
    await settle();

    const select = () => app.element.querySelector('[data-shop-category="stock"]');
    const visible = () => [...app.element.querySelectorAll(".shop-panel--stock .shop-tile")]
      .filter(tile => !tile.classList.contains("is-filtered"))
      .map(tile => tile.dataset.name.replace(`${PREFIX} `, "")).sort();
    const choose = async value => {
      select().value = value;
      select().dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    };

    if ( !report.check("the stock panel has an item type dropdown", !!select()) ) return report.summary;
    const values = [...select().options].map(o => o.value);
    report.check("it offers exactly the categories on the shelves",
      JSON.stringify([...values].sort()) === JSON.stringify(["", "equipment", "equipment:heavy", "loot",
        "loot:gem", "weapon", "weapon:martialM", "weapon:simpleM"].sort()), values.join(", "));
    report.check("and nothing the shelves do not hold", !values.includes("consumable") && !values.includes("tool"));
    report.check("with All items first", values[0] === "" && select().value === "");

    await choose("weapon");
    report.check("choosing a type shows every item of it",
      JSON.stringify(visible()) === JSON.stringify(["Dagger", "Longsword"]), visible().join(", "));

    await choose("equipment:heavy");
    report.check("choosing a subtype shows only that subtype",
      JSON.stringify(visible()) === JSON.stringify(["Plate"]), visible().join(", "));
    report.check("the panel count follows the filter",
      /(^|\D)1(\D|$)/.test(app.element.querySelector(".shop-panel--stock [data-shop-count]")?.textContent ?? ""),
      app.element.querySelector(".shop-panel--stock [data-shop-count]")?.textContent);

    // Search and type together: a tile must match both.
    await choose("weapon");
    const search = app.element.querySelector('[data-shop-search="stock"]');
    search.value = "long";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    report.check("the type filter and the search box combine",
      JSON.stringify(visible()) === JSON.stringify(["Longsword"]), visible().join(", "));
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    await app.render();
    await settle();
    report.check("the chosen type survives a re-render",
      select()?.value === "weapon" && JSON.stringify(visible()) === JSON.stringify(["Dagger", "Longsword"]),
      `${select()?.value}: ${visible().join(", ")}`);

    // The pack panel offers only what the character carries.
    const packSelect = app.element.querySelector('[data-shop-category="pack"]');
    const packTiles = [...app.element.querySelectorAll(".shop-panel--pack .shop-tile")];
    if ( packTiles.length ) {
      const held = new Set(packTiles.flatMap(tile => tile.dataset.categories.split(" ")));
      const offered = [...(packSelect?.options ?? [])].map(o => o.value).filter(Boolean);
      report.check("the pack's dropdown lists only what the character carries",
        !!packSelect && offered.every(value => held.has(value)), offered.join(", "));
    }

    // The last of a type sells out while it is selected: the filter lets go.
    await choose("loot");
    await trader.items.find(i => i.name.includes("Ruby")).delete();
    await new Promise(resolve => setTimeout(resolve, 900));
    report.check("when the chosen type sells out the filter returns to All items",
      select()?.value === "" && visible().length === 3, `${select()?.value}: ${visible().join(", ")}`);
    report.check("and no longer offers the type that sold out",
      ![...select().options].some(o => o.value === "loot"));
  } catch ( err ) {
    report.fail("typeFilterSuite threw", err);
  } finally {
    await app?.close().catch(() => {});
    if ( trader ) await trader.delete().catch(() => {});
  }
  return report.summary;
}

/* -------------------------------------------- */
/*  The Ember skin                              */
/* -------------------------------------------- */

/**
 * Every file styles/ember-skin.css borrows from Ember's own folder. Kept in step with the asset
 * manifest at the top of that file: a file Ember renames in a release breaks the skin silently,
 * and fetching each one is the only thing that notices.
 */
const EMBER_ASSETS = [
  "ui/elements/codex-background-dark.webp",
  "ui/elements/cosmos-design-weathered.webp",
  "ui/borders/BlockActorRing.webp"
];

/** What `emberSuite` leaves open for the runner to photograph, and `closeEmberFixture` undoes. */
let emberFixture = null;

/**
 * Open the shop and the manager as they would look in an Ember world.
 *
 * Ember is a paid, protected module and the test world does not enable it, so its presence is
 * simulated: `game.modules.get("ember")` reports it active for the duration, and Ember's two
 * typefaces are loaded straight from its folder, which is all its global stylesheet would have
 * contributed to our windows. Everything else — the class, the skin, the art — is the real code
 * path. On a machine without Ember installed the suite reports that and skips, rather than
 * failing on art that is not there.
 *
 * @param {{mode?: "windowed"|"fullscreen", keepOpen?: boolean}} [options]
 *   `keepOpen` leaves both windows up so the runner can take a screenshot; call
 *   `closeEmberFixture` afterwards.
 */
export async function emberSuite({ mode = "fullscreen", keepOpen = false } = {}) {
  const report = new Report();
  const tag = `[ember ${mode}]`;
  const installed = await fetch("/modules/ember/module.json", { method: "HEAD" })
    .then(r => r.ok).catch(() => false);
  if ( !installed ) {
    report.check(`${tag} skipped: Ember is not installed on this machine`, true);
    return report.summary;
  }

  const api = game.modules.get(MODULE)?.api;
  const originalGet = game.modules.get;
  const restoreMode = game.settings.get(MODULE, "displayMode");
  let trader = null;
  let shop = null;
  let manager = null;

  const teardown = async () => {
    await shop?.close().catch(() => {});
    await manager?.close().catch(() => {});
    game.modules.get = originalGet;
    if ( trader ) await trader.delete().catch(() => {});
    await game.settings.set(MODULE, "displayMode", restoreMode);
  };

  try {
    // Without Ember the windows must not wear the skin — checked before the simulation starts.
    const plain = await import(`/modules/${MODULE}/scripts/config.mjs`);
    report.check(`${tag} without Ember the windows get no ember class`,
      !plain.launchWindowOptions().classes.includes("sogrom-ember"));

    game.modules.get = function(id) {
      if ( id === "ember" ) return { id: "ember", active: true };
      return originalGet.call(this, id);
    };
    for ( const [family, file] of [
      ["Vollkorn", "Vollkorn/Vollkorn.ttf"], ["Pirate Scroll", "PirateScroll/PirateScroll.otf"]
    ] ) {
      if ( [...document.fonts].some(face => face.family.replaceAll('"', "") === family) ) continue;
      const face = new FontFace(family, `url("/modules/ember/assets/fonts/${file}")`);
      document.fonts.add(await face.load().catch(() => face));
    }
    await game.settings.set(MODULE, "displayMode", mode);

    // Every borrowed file is really there, at the path the stylesheet uses.
    for ( const asset of EMBER_ASSETS ) {
      const ok = await fetch(`/modules/ember/${asset}`, { method: "HEAD" }).then(r => r.ok).catch(() => false);
      report.check(`${tag} Ember still ships ${asset}`, ok);
    }

    trader = await api.createTrader({ name: `${PREFIX} Ember Trader`, greeting: "Warm yourself by the fire." });
    await trader.update({ "system.currency": { pp: 0, gp: 120, ep: 0, sp: 0, cp: 0 } });
    await trader.createEmbeddedDocuments("Item", [
      { name: `${PREFIX} Ember Lantern`, type: "loot", img: "icons/sundries/lights/lantern-iron-yellow.webp",
        system: { quantity: 3, price: { value: 5, denomination: "gp" }, rarity: "uncommon" },
        flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 3 } } },
      { name: `${PREFIX} Ember Blade`, type: "weapon", img: "icons/weapons/swords/sword-guard-red.webp",
        system: { quantity: 1, price: { value: 40, denomination: "gp" }, rarity: "rare" },
        flags: { [MODULE]: { unlimited: false, overrideCp: null, revealAt: null, baseQty: 1 } } }
    ]);

    const character = game.actors.find(a => a.name === `${PREFIX} Vex`);
    shop = await api.openShop(trader.id, { actor: character });
    await settle();

    const root = shop?.element;
    if ( !report.check(`${tag} the shop renders`, !!root) ) return report.summary;
    report.check(`${tag} the shop wears the ember class`, root.classList.contains("sogrom-ember"),
      [...root.classList].join(" "));

    const ground = mode === "fullscreen" ? root : root.querySelector(".window-content");
    const groundImage = getComputedStyle(ground).backgroundImage;
    report.check(`${tag} the window ground is Ember's codex paper`,
      groundImage.includes("codex-background-dark"), groundImage);

    const portrait = root.querySelector(".shop-party-img");
    const ring = portrait ? getComputedStyle(portrait.parentElement, "::after").backgroundImage : "";
    report.check(`${tag} the portraits wear Ember's ring`, ring.includes("BlockActorRing"), ring);
    report.check(`${tag} and are clipped to a circle`,
      !!portrait && getComputedStyle(portrait).borderRadius === "50%", getComputedStyle(portrait).borderRadius);
    const rect = portrait?.getBoundingClientRect();
    report.check(`${tag} and are still 204x204`,
      Math.round(rect?.width) === 204 && Math.round(rect?.height) === 204,
      `${Math.round(rect?.width)}x${Math.round(rect?.height)}`);

    const heading = root.querySelector(".shop-party-name");
    report.check(`${tag} headings use Ember's display face`,
      getComputedStyle(heading).fontFamily.includes("Pirate Scroll"), getComputedStyle(heading).fontFamily);
    report.check(`${tag} body text uses Vollkorn`,
      getComputedStyle(root).fontFamily.includes("Vollkorn"), getComputedStyle(root).fontFamily);

    // The windows stay usable, not just recoloured.
    doubleClick(root.querySelector(".shop-panel--stock .shop-tile .shop-tile-button"));
    await settle();
    report.check(`${tag} staging still works under the skin`, !!shop.element.querySelector(".shop-staged-row"));

    if ( keepOpen ) {
      emberFixture = { teardown };
      return report.summary;
    }

    // The manager: same class, and the portrait picker ringed.
    await shop.close();
    shop = null;
    manager = api.openManager();
    await settle();
    manager.element.querySelector(`[data-trader-id="${trader.id}"] [data-action="selectTrader"]`)?.click();
    await settle();
    report.check(`${tag} the manager wears the ember class`, manager.element.classList.contains("sogrom-ember"));
    const picker = manager.element.querySelector(".shop-portrait");
    report.check(`${tag} the manager's portrait wears Ember's ring`,
      !!picker && getComputedStyle(picker, "::after").backgroundImage.includes("BlockActorRing"));
    const overlap = railOverlap(manager.element);
    report.check(`${tag} no two Traders in the rail overlap under Ember's wider type`, !overlap, overlap);
  } catch ( err ) {
    report.fail(`emberSuite (${mode}) threw`, err);
  }

  await teardown();
  return report.summary;
}

/**
 * The first pair of rail rows that overlap, described, or "" if none do. A row whose text
 * outgrows Foundry's fixed button height spills over the row beneath it, which is exactly what
 * Ember's wider typeface once did.
 */
function railOverlap(root) {
  const rows = [...root.querySelectorAll(".shop-rail-row")].map(row => row.getBoundingClientRect());
  for ( let i = 1; i < rows.length; i++ ) {
    if ( rows[i].top < rows[i - 1].bottom - 0.5 ) {
      return `row ${i} starts at ${Math.round(rows[i].top)} but row ${i - 1} ends at ${Math.round(rows[i - 1].bottom)}`;
    }
  }
  return "";
}

/** Close what `emberSuite({keepOpen: true})` left up, and stop simulating Ember. */
export async function closeEmberFixture() {
  const fixture = emberFixture;
  emberFixture = null;
  await fixture?.teardown();
  return true;
}

/** Open the manager on the Ember Trader for a screenshot. Pairs with `closeEmberFixture`. */
export async function emberManagerFixture() {
  const summary = await emberSuite({ mode: "fullscreen", keepOpen: true });
  const { ShopApp } = await import(`/modules/${MODULE}/scripts/app/shop-app.mjs`);
  for ( const app of ShopApp.instances ) await app.close();
  const api = game.modules.get(MODULE).api;
  const manager = api.openManager();
  await settle();
  const trader = game.actors.find(a => a.name === `${PREFIX} Ember Trader`);
  manager.element.querySelector(`[data-trader-id="${trader?.id}"] [data-action="selectTrader"]`)?.click();
  await settle();
  const previous = emberFixture;
  emberFixture = { teardown: async () => { await manager.close().catch(() => {}); await previous?.teardown(); } };
  return summary;
}

/* -------------------------------------------- */

/**
 * Pull the raw keys out of some markup, for a failure message.
 *
 * A missing localisation key renders as its own path, so the failure is far easier to act on
 * when the message names the key rather than just saying one was found.
 */
function rawKeys(root) {
  const matches = root.textContent.match(new RegExp(`${MODULE}\\.[A-Za-z0-9_.]+`, "g")) ?? [];
  return [...new Set(matches)].slice(0, 5).join(", ");
}

/* -------------------------------------------- */

/**
 * The magic item chooser, in both display modes: a dropped DMG template and the Stock tab's
 * "Magic item…" button must each open a dialog the GM can actually see and use.
 *
 * Measured with `elementFromPoint` rather than trusted: in full screen the manager sits at a very
 * high z-index, and a dialog that rendered underneath it looked fine to every other check while
 * being impossible to click.
 * @param {"windowed"|"fullscreen"} mode
 */
export async function magicItemDialogSuite(mode = "windowed") {
  const report = new Report();
  const api = game.modules.get(MODULE)?.api;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const DialogV2 = foundry.applications.api.DialogV2;
  const dialogNow = () => [...foundry.applications.instances.values()].find(a => a instanceof DialogV2);
  const onTop = dialog => {
    const rect = dialog.element.getBoundingClientRect();
    return dialog.element.contains(document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2)));
  };
  let trader = null;
  let app = null;
  let restore = null;

  try {
    const pack = game.packs.get("dnd-dungeon-masters-guide.equipment");
    if ( !report.check("the DMG is enabled", !!pack) ) return report.summary;
    const index = await pack.getIndex({ fields: ["system.identifier"] });
    const uuid = index.find(e => e.system?.identifier === "weapon-1-2-or-3")?.uuid;

    restore = game.settings.get(MODULE, "displayMode");
    await game.settings.set(MODULE, "displayMode", mode);
    trader = await api.createTrader({ name: `${PREFIX} Magic Counter` });

    const { TraderManagerApp } = await import(`/modules/${MODULE}/scripts/app/manager-app.mjs`);
    await foundry.applications.instances.get(`${MODULE}-manager`)?.close();
    app = TraderManagerApp.launch();
    await wait(1500);
    app.element.querySelector(`[data-trader-id="${trader.id}"] [data-action="selectTrader"]`)?.click();
    await wait(500);
    app.element.querySelector('[data-action="selectTab"][data-tab="stock"]')?.click();
    await wait(500);

    // A dropped template.
    const transfer = new DataTransfer();
    transfer.setData("text/plain", JSON.stringify({ type: "Item", uuid }));
    app.element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    for ( let i = 0; i < 20 && !dialogNow(); i++ ) await wait(250);
    let dialog = dialogNow();
    if ( report.check("dropping a template opens the chooser", !!dialog) ) {
      report.check("and the GM can see it", onTop(dialog), `dialog z=${getComputedStyle(dialog.element).zIndex}`);
      await dialog.close();
      await wait(300);
    }

    // The button.
    const button = app.element.querySelector('[data-action="makeMagicItem"]');
    if ( report.check("the Stock tab has a Magic item button", !!button) ) {
      button.click();
      for ( let i = 0; i < 60 && !dialogNow(); i++ ) await wait(250);
      dialog = dialogNow();
      if ( report.check("which opens the chooser", !!dialog) ) {
        report.check("where the GM can see it", onTop(dialog), `dialog z=${getComputedStyle(dialog.element).zIndex}`);
        const select = dialog.element.querySelector("[name=template]");
        report.check("listing the templates to choose from", (select?.options.length ?? 0) > 1);
        const plus = [...(select?.options ?? [])].find(o => o.value === uuid);
        if ( plus ) {
          select.value = plus.value;
          select.dispatchEvent(new Event("change"));
          await wait(1200);
        }
        const profile = dialog.element.querySelector("[name=profile]");
        report.check("changing the template reloads its enchantments", profile?.options[0]?.textContent.startsWith("Weapon +1"),
          profile?.options[0]?.textContent);
        const base = dialog.element.querySelector("[name=base]");
        const longsword = [...(base?.options ?? [])].find(o => o.textContent.startsWith("Longsword"));
        if ( longsword ) base.value = longsword.value;
        dialog.element.querySelector('[data-action="ok"]')?.click();
        await wait(2000);
        report.check("and confirming stocks the finished item", trader.items.some(i => i.name === "Longsword +1"),
          trader.items.map(i => i.name).join(", "));
      }
    }
  } catch ( err ) {
    report.fail(`magicItemDialogSuite (${mode}) threw`, err);
  } finally {
    await dialogNow()?.close().catch(() => {});
    await app?.close().catch(() => {});
    if ( trader ) await trader.delete().catch(() => {});
    if ( restore !== null ) await game.settings.set(MODULE, "displayMode", restore);
  }
  for ( const item of report.cases ) item.name = `[${mode}] ${item.name}`;
  return report.summary;
}

export async function all() {
  const suites = {
    manager: managerSuite,
    "magic-item-dialog": () => magicItemDialogSuite("windowed"),
    "magic-item-dialog-fullscreen": () => magicItemDialogSuite("fullscreen"),
    shop: () => shopSuite("windowed"),
    "shop-fullscreen": () => shopSuite("fullscreen"),
    "type-filter": typeFilterSuite,
    "ember-fullscreen": () => emberSuite({ mode: "fullscreen" }),
    "ember-windowed": () => emberSuite({ mode: "windowed" })
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
