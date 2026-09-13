import { launchWindowOptions, fullscreen, t } from "../config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The chrome both full-screen windows share — the player's shop ({@link module:app/shop-app})
 * and the GM's Trader Manager ({@link module:app/manager-app}).
 *
 * Both are the same shape of window: a band across the top, panelled columns below it, and a
 * footer. Only the panels differ, so everything around them lives here.
 *
 * For a junior dev: the two display modes are the reason this base exists at all. In
 * *fullscreen* the window is an unframed, unpositioned `div` covering the viewport, which means
 * Foundry draws no title bar and therefore no close button — so the shell has to supply its own
 * Escape handling and a close control in the template. In *windowed* it is an ordinary framed
 * application and Foundry's own chrome does that job. Rather than branch in two subclasses,
 * {@link launchWindowOptions} resolves the difference once and the constructor merges it in.
 *
 * Subclasses declare their own `DEFAULT_OPTIONS` freely: ApplicationV2 merges the static options
 * down the inheritance chain (plain objects recursively, arrays concatenated), so `actions` and
 * `classes` declared here are inherited rather than overwritten, and a subclass need not
 * re-declare them.
 */
export class ShopShellBase extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * Merge the display-mode options in at construction time.
   *
   * This is done in the constructor rather than at every call site because
   * `game.settings.registerMenu` constructs the application itself (`new Type()`), with no
   * chance to pass options — so a menu-opened Trader Manager would otherwise always be an
   * unframed div with no way to close it, whatever the world's display mode says.
   * @param {object} [options]  ApplicationV2 options; these win over the display mode's.
   */
  constructor(options = {}) {
    super(foundry.utils.mergeObject(launchWindowOptions(), options, { inplace: false }));
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["sogrom-shop"],
    tag: "div",
    // The unframed shape, which `launchWindowOptions()` overrides for the windowed mode that is
    // now the default. Declared this way round because an unframed div is the shape the CSS is
    // written against, so anything that fails to consult the setting fails toward the layout
    // that is known to work rather than toward one that was never checked.
    window: { frame: false, positioned: false },
    actions: {
      closeShell: ShopShellBase.#onCloseShell
    }
  };

  /** Whether the Escape listener is attached. The root element persists across re-renders. */
  #escapeWired = false;

  /* -------------------------------------------- */

  /** Close from the template's own control. Named so it cannot clash with a subclass action. */
  static #onCloseShell() {
    this.close();
  }

  /* -------------------------------------------- */

  /**
   * Close on Escape while a full-screen window is up.
   *
   * Foundry's Escape keybinding closes the focused *framed* application; an unframed,
   * unpositioned element is not in that conversation, so without this a fullscreen shell could
   * only be closed by clicking its own control. The listener goes on the root element rather
   * than the document so it dies with the window, and it is skipped in windowed mode where
   * Foundry already handles it.
   * @override
   */
  _onRender(context, options) {
    super._onRender(context, options);
    if ( !fullscreen() || this.#escapeWired ) return;
    this.#escapeWired = true;
    // The element is made focusable so it can receive the key at all, and the listener captures
    // so it runs before anything inside the window swallows it.
    this.element.tabIndex = -1;
    this.element.addEventListener("keydown", event => {
      if ( event.key !== "Escape" ) return;
      event.preventDefault();
      this.close();
    }, { capture: true });
    this.element.focus({ preventScroll: true });
  }

  /* -------------------------------------------- */

  /**
   * The context every shell template can rely on: whether the window draws its own chrome, and
   * the close control's label. Subclasses spread their own context on top.
   * @override
   */
  async _prepareContext(options) {
    return Object.assign(await super._prepareContext(options), {
      fullscreen: fullscreen(),
      closeLabel: t("common.close")
    });
  }
}
