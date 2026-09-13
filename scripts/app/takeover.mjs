import { log } from "../config.mjs";

/**
 * Keeping other people's windows visible over the full-screen shop.
 *
 * The shop and the Trader Manager run as a fixed, viewport-filling element sitting just under
 * Foundry's tooltip layer (~9998) — high enough that the character sheet behind them cannot peek
 * through, which is the entire point of a takeover. The cost is that *every* Foundry window is
 * behind them too, including ones opened deliberately from inside our own UI: click a tile and
 * the item sheet renders faithfully, at a z-index in the low hundreds, completely hidden
 * underneath us.
 *
 * So the window that was opened is raised above us, and we stay where we are.
 *
 * **Raising, not lowering.** Dropping the takeover below Foundry's window layer would not reveal
 * *the* window that was opened — it would reveal *every* window, including the character sheet
 * the takeover exists to cover. And we do not have to out-specify anyone else's class names: the
 * render hook hands us the application, so we put *our own* class on its element, and
 * `!important` beats the inline z-index Foundry rewrites on render and on focus.
 *
 * Raising also deletes the bookkeeping the alternative would need. There is no reference count,
 * because each window carries its own class; nothing has to be restored when a window closes,
 * because the class dies with the element it is on; and no `close` wrapper is needed, so no exit
 * path can strand us in a lowered state.
 *
 * Two things keep it honest, because the class sits on an element that is not ours and we
 * therefore cannot reliably take it off again:
 *
 *  - **Only on opening.** A window is raised on its *first* render, never on a re-render. A
 *    re-render means "this was already open behind us" — a character sheet refreshing as a
 *    purchase lands on it is precisely what the takeover is covering, and raising it would
 *    flash the sheet over the shop on every single trade.
 *  - **Only while a takeover is up.** The CSS gates on `body:has(.sogrom-shop-fullscreen)`, so
 *    the class goes inert when the shop closes rather than leaving a sheet the player opened
 *    from a tile floating over everything for the rest of the session.
 *
 * One accepted limitation: raised windows share one z-index, so clicking between two of them
 * cannot reorder them — they stack in DOM order. Two windows open over the shop at once is
 * already rare, and far cheaper than burying either.
 *
 * Adapted from the same solution in the Simple D&D Character Creator, which is where the two
 * wrong designs above were tried first.
 */

/** The class that lifts someone else's window above the takeover. Styled in shop.css. */
const ABOVE = "sogrom-shop-above";

/**
 * Every application seen render since the world loaded, so a *first* render can be told from a
 * re-render. Weak, so it never holds a closed application alive.
 * @type {WeakSet<object>}
 */
const seen = new WeakSet();

/** The live full-screen element, or null in windowed mode, which stacks correctly already. */
function takeoverRoot() {
  return document.querySelector(".sogrom-shop-fullscreen");
}

/**
 * Whether a rendered application is someone else's window that the takeover would otherwise
 * bury.
 *
 * Narrow on shape, not on purpose. `renderApplicationV2` fires for *every* ApplicationV2 in the
 * world — the hook dispatcher walks the whole inheritance chain — so this filters down to framed
 * windows, and skips our own shells, which would otherwise be asked to float above themselves.
 *
 * It used to demand a document as well, and that buried every **dialog** opened from inside a
 * full-screen window: a confirmation, the enchantment chooser, the compendium browser. None of
 * them is a document sheet, so each opened at a z-index in the low hundreds, underneath the
 * takeover, waiting for a click nobody could make. Only a window that *opens* while the takeover
 * is up is raised (see {@link watchForeignWindows}), so widening this cannot lift a sheet that was
 * already open behind the shop.
 * @param {object} application
 * @returns {boolean}
 */
export function isForeignWindow(application) {
  if ( !application ) return false;
  if ( application.hasFrame === false ) return false;     // an unframed overlay, not a window
  // Our own shells are ApplicationV2 too; they carry `sogrom-shop` from DEFAULT_OPTIONS.
  return !application.element?.classList?.contains("sogrom-shop");
}

/**
 * Claim an application as a window opened from inside the shop, and lift it above.
 *
 * Safe to call repeatedly, and safe to call **before the application has rendered** — which is
 * the normal case for a FilePicker, whose `render()` resolves asynchronously and whose `element`
 * is therefore still null the instant after the call. An application with no element yet is
 * marked instead, and {@link watchForeignWindows} finishes the job when it renders.
 *
 * This is the *explicit* claim, for a window we opened ourselves and whose provenance we
 * therefore know. The mark it leaves outlives the current takeover, so it must never be applied
 * speculatively — the watcher uses the private {@link raise} for windows it merely recognises.
 * @param {object} application
 */
export function yieldTakeoverTo(application) {
  if ( !application ) return;
  // Marked on the application rather than tracked in a module-level set: it travels with the
  // object, so it cannot leak between sessions or outlive the window it describes.
  application.__sogromShopAbove = true;
  raise(application);
}

/**
 * Put the class on, if there is a takeover to clear and an element to put it on.
 * @param {object} application
 */
function raise(application) {
  if ( !takeoverRoot() ) return;      // windowed mode already stacks correctly
  application.element?.classList.add(ABOVE);
}

/**
 * Raise any document sheet that opens while a full-screen window is up.
 *
 * This exists for content links our own screens render — a tile's item sheet, a stock row's.
 * Those are Foundry's `.content-link` anchors handled by a global listener inside the system,
 * so the click never reaches us and there is no callback to hang this on. Watching the render
 * hook is the only seam that catches them.
 *
 * It is also what completes a claim made before the window existed (see {@link yieldTakeoverTo})
 * and what re-applies the class if a re-render should ever replace the root element.
 */
export function watchForeignWindows() {
  Hooks.on("renderApplicationV2", application => {
    try {
      if ( !application ) return;
      // Whether this is the first time this window has rendered at all. Registered at `init`,
      // so this hook has seen every render since the world loaded.
      const opening = !seen.has(application);
      seen.add(application);

      // An explicit claim is honoured on whichever render lands first — the whole point of being
      // able to claim a window before it has an element.
      if ( application.__sogromShopAbove ) return raise(application);

      // Only a window that *opened* while the takeover was up was opened from inside it. One
      // that merely re-renders underneath it was already there and belongs where it is. The case
      // that forces this: settling a trade updates the character's sheet, which is the very
      // window the shop is covering.
      if ( !opening || !isForeignWindow(application) ) return;

      // Deliberately `raise` and not `yieldTakeoverTo`: this path must leave no mark behind. A
      // window that renders with no takeover on screen has to stay a window with no claim on
      // one, or the next time a shop opened it would jump over it — and this hook sees every
      // window in the world.
      raise(application);
    } catch ( err ) {
      // Never let a stacking nicety break someone else's window opening.
      log("could not raise a foreign window over the shop", err);
    }
  });
}
