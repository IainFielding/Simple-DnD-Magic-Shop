/**
 * Shared constants and small runtime helpers for the Magic Shop.
 *
 * Kept deliberately free of Application/DOM concerns so every layer (data, trade, app) can
 * import from here without pulling in the UI.
 *
 * For a junior dev: this is the "grab bag" every other file imports from. If you need a
 * constant or a tiny helper that has nothing to do with the UI, it probably lives here.
 * Nothing in this file touches the DOM or a Foundry Application.
 */

/**
 * The module's unique id. Must match the `id` field in module.json — Foundry uses it to
 * namespace our settings, templates, flags and localisation keys so they can never collide
 * with another module's.
 */
export const MODULE_ID = "sogrom-simple-dnd5e-magic-shop";

/** The dnd5e item types a Trader can stock: priced physical gear. Mirrors the system's own list. */
export const PHYSICAL_TYPES = ["weapon", "equipment", "consumable", "tool", "container", "loot"];

/**
 * Item rarity keys in ascending order, as the shop normalises them.
 *
 * dnd5e stores `system.rarity` as `veryRare` (and older data as "Very Rare"); the shared palette
 * in `sogrom-dms-toolkit` keys its colours on the lowercased, whitespace-stripped form, so the
 * shop uses that form everywhere — for CSS classes and for the GM's rarity filters alike. Run a
 * raw system value through {@link normalizeRarity} before comparing it to anything here.
 */
export const RARITIES = ["common", "uncommon", "rare", "veryrare", "legendary", "artifact"];

/**
 * Normalise a raw `system.rarity` value to one of {@link RARITIES}.
 *
 * Lowercase, strip whitespace — the same normalisation the DM's Toolkit applies, so an item
 * wears the same colour in the shop as it does on a character sheet. Anything unrecognised
 * (a homebrew rarity, an empty string, a mundane item) comes back `""`, meaning "no rarity",
 * which the tile styling treats as plain rather than guessing.
 * @param {string} [raw]
 * @returns {string}  A key from {@link RARITIES}, or "".
 */
export function normalizeRarity(raw) {
  if ( typeof raw !== "string" ) return "";
  const key = raw.replaceAll(/\s/g, "").toLowerCase().trim();
  return RARITIES.includes(key) ? key : "";
}

/* -------------------------------------------- */
/*  Public hook surface                         */
/* -------------------------------------------- */

/**
 * The namespace every hook this module emits is prefixed with.
 *
 * Deliberately *not* "sogrom": the same author publishes a dozen other `sogrom-*` modules, so
 * that namespace would be ambiguous the moment any of them wanted a hook of its own. This is
 * the camelCase of the module title, which is the convention Foundry modules follow.
 *
 * Changing this string is a breaking change for every consumer, so treat it as permanent.
 */
export const HOOK_PREFIX = "simpleMagicShop";

/**
 * Every hook this module emits, as `alias -> full hook name`.
 *
 * One map means the code that *emits* a hook and the code that documents or re-exports it can
 * never drift. The whole map is published on the public API
 * (`game.modules.get(MODULE_ID).api.HOOKS`) so a consumer can subscribe without hard-coding
 * strings, and is frozen so nobody can rewrite a name at runtime.
 *
 * Two kinds, distinguished by the `pre` prefix and by which helper fires them:
 *  - **`pre…` hooks are cancellable.** They go through {@link fireCancellableHook}, which uses
 *    `Hooks.call`; a listener returning `false` aborts the action. This is dnd5e's own house
 *    style.
 *  - **Everything else is notification-only**, fired with `Hooks.callAll` via {@link fireHook}.
 *    A listener's return value is ignored.
 *
 * `prePrice` is the one exception to both: it is fired notification-style, but its payload
 * carries a mutable `multipliers` object that the pricing path reads back afterwards. That is
 * the extension point for bespoke pricing (a haggle result, a guild discount, a curse) without
 * forking the module.
 *
 * Every payload is a single object argument, so a hook can gain a field later without breaking
 * listeners that destructure the ones they already know about.
 *
 * See docs/API.md for the payload of each.
 */
export const HOOKS = Object.freeze({
  /** `{api, version}` — the module is ready and its API is installed. */
  ready: `${HOOK_PREFIX}.ready`,

  /** `{trader}` — a Trader actor was created by the module. */
  traderCreated: `${HOOK_PREFIX}.traderCreated`,
  /** `{trader}` — a Trader was deleted through the module (fired before the document goes). */
  traderDeleted: `${HOOK_PREFIX}.traderDeleted`,
  /** `{trader, message}` — a Trader's card was posted to chat. */
  traderCardPosted: `${HOOK_PREFIX}.traderCardPosted`,

  /** `{trader, actor, user}` — **cancellable**; return false to stop the shop opening. */
  preOpenShop: `${HOOK_PREFIX}.preOpenShop`,
  /** `{app, trader, actor}` — the shop is open and showing stock. */
  shopOpened: `${HOOK_PREFIX}.shopOpened`,
  /** `{app, trader, actor}` — the shop was closed. */
  shopClosed: `${HOOK_PREFIX}.shopClosed`,

  /**
   * `{trader, actor, intent, priced}` — **cancellable**, fired on the GM client inside the
   * authoritative path, after prices are derived and before anything is written. Return false
   * to veto a trade the players have already confirmed.
   */
  preTrade: `${HOOK_PREFIX}.preTrade`,
  /** `{trader, actor, receipt}` — a trade settled; everything is written. */
  tradeCompleted: `${HOOK_PREFIX}.tradeCompleted`,
  /** `{trader, actor, intent, reason}` — a trade was refused, by validation or by a veto. */
  tradeRejected: `${HOOK_PREFIX}.tradeRejected`,

  /**
   * `{trader, actor, item, valueCp, multipliers}` — **mutate `multipliers` to override**. Fired
   * once per priced line, on whichever client is doing the pricing.
   */
  prePrice: `${HOOK_PREFIX}.prePrice`,

  /** `{trader, actor, from, to, reason}` — **cancellable**; return false to keep the old value. */
  preAttitudeChange: `${HOOK_PREFIX}.preAttitudeChange`,
  /** `{trader, actor, from, to, reason}` — a Trader's opinion of a character changed. */
  attitudeChanged: `${HOOK_PREFIX}.attitudeChanged`,

  /** `{trader}` — **cancellable**; return false to skip a restock. */
  preRestock: `${HOOK_PREFIX}.preRestock`,
  /** `{trader, added}` — stock was replenished; `added` is per-line `{itemId, from, to}`. */
  restocked: `${HOOK_PREFIX}.restocked`
});

/**
 * Fire a notification-only hook. Never throws: a listener in another module blowing up must not
 * take a trade down with it, so a bad listener is logged and the flow continues.
 * @param {string} hook     A value from {@link HOOKS}.
 * @param {object} payload  The single object argument handed to listeners.
 */
export function fireHook(hook, payload) {
  log(`hook ${hook}`, payload);
  try {
    Hooks.callAll(hook, payload);
  } catch ( err ) {
    // Foundry already reports a throwing listener; this only stops it unwinding *our* call stack.
    log(`listener threw on ${hook}`, err);
  }
}

/**
 * Fire a cancellable hook and report whether the action may proceed.
 *
 * `Hooks.call` stops at the first listener that returns exactly `false` and hands that back,
 * which is the contract dnd5e uses for its own `pre…` hooks. A listener that throws is treated
 * as *not* a veto — silently cancelling a trade because somebody else's module has a bug would
 * be a much worse failure than ignoring them.
 * @param {string} hook     A value from {@link HOOKS}.
 * @param {object} payload  The single object argument handed to listeners.
 * @returns {boolean}       False when a listener vetoed; true to carry on.
 */
export function fireCancellableHook(hook, payload) {
  log(`hook ${hook} (cancellable)`, payload);
  let allowed = true;
  try {
    allowed = Hooks.call(hook, payload) !== false;
  } catch ( err ) {
    log(`listener threw on ${hook}; treating as no veto`, err);
    return true;
  }
  if ( !allowed ) log(`${hook} vetoed by a listener`);
  return allowed;
}

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

/**
 * The string keys for every world setting this module registers with Foundry.
 *
 * Centralising them here means the code that *registers* a setting and the code that *reads*
 * it always use the exact same key — no risk of a typo silently reading `undefined`.
 */
export const SETTINGS = {
  /** Hidden. The Trader registry: display order, and the folder the actors live in. */
  traders: "traders",
  /** Hidden. Id of the module-managed Actors folder holding Trader actors. */
  traderFolder: "traderFolder",
  /** Whether the shop button appears in the scene-controls toolbar (GM only). */
  sceneButton: "showSceneButton",
  /** Fullscreen or windowed, for both the shop and the Trader Manager. */
  displayMode: "displayMode",
  /** Which {@link PRICING_PRESETS} entry is in force, or "custom". */
  pricingPreset: "pricingPreset",
  /** Hidden. The custom anchor set, used only while `pricingPreset` is "custom". */
  pricingAnchors: "pricingAnchors",
  /** The attitude a Trader starts every character at, unless the Trader overrides it. */
  startingAttitude: "startingAttitude",
  /** Copper a character must spend with a Trader to earn one point of attitude. */
  attitudeGainPerPoint: "attitudeGainPerPoint",
  /** Most attitude a single visit can earn, however much is spent. */
  attitudeGainCap: "attitudeGainCap",
  /** Hidden. The GM's own saved archetypes; the built-in ones live in `data/archetypes.mjs`. */
  archetypes: "archetypes",
  debug: "debugLogging"
};

/**
 * The three price anchors that define a pricing curve, as buy/sell multipliers on item value.
 *
 * `hostile` is the pair at Favour −1, `neutral` at Favour 0, `devoted` at Favour +1; everything
 * between is interpolated. See `data/pricing.mjs` for the model and docs/PLAN.md §3 for why it
 * is shaped this way.
 *
 * **The invariant every anchor set must satisfy:** `devoted.buy > devoted.sell`. If the best
 * sell multiplier ever reached or exceeded the best buy multiplier, a character could buy an
 * item and sell it straight back for profit — an infinite gold loop. `validateAnchors()` in
 * `data/pricing.mjs` enforces it, and the custom-anchor editor, when it lands, must refuse to save a set that breaks it.
 */
export const PRICING_PRESETS = Object.freeze({
  /** Straight 5e RAW at the neutral anchor: pay list price, sell at half. */
  fair: Object.freeze({
    hostile: Object.freeze({ buy: 1.35, sell: 0.35 }),
    neutral: Object.freeze({ buy: 1.00, sell: 0.50 }),
    devoted: Object.freeze({ buy: 0.80, sell: 0.65 })
  }),
  /**
   * The default. A stranger pays a 10% markup, which is what gives goodwill somewhere to go:
   * with a neutral buy of 1.00 the best a devoted Trader could ever offer is a ~7% discount,
   * which does not feel like a reward.
   */
  standard: Object.freeze({
    hostile: Object.freeze({ buy: 1.60, sell: 0.30 }),
    neutral: Object.freeze({ buy: 1.10, sell: 0.45 }),
    devoted: Object.freeze({ buy: 0.80, sell: 0.62 })
  }),
  /** For a scarcity campaign: strangers are gouged and only real goodwill approaches fair. */
  harsh: Object.freeze({
    hostile: Object.freeze({ buy: 2.20, sell: 0.20 }),
    neutral: Object.freeze({ buy: 1.30, sell: 0.40 }),
    devoted: Object.freeze({ buy: 0.85, sell: 0.60 })
  })
});

/**
 * The fallback value for each setting, used when the world hasn't overridden it (and as the
 * `default` handed to Foundry at registration time).
 */
export const DEFAULTS = {
  traders: { order: [] },
  traderFolder: "",
  sceneButton: true,
  // Windowed by default. A window that covers the whole viewport is the better *shopping*
  // experience, but it is a surprising thing for a module to do the first time you open it, and
  // it hides the chat log the card was clicked from. A GM who wants the takeover can say so.
  displayMode: "windowed",
  pricingPreset: "standard",
  // Only consulted while `pricingPreset` is "custom"; seeded from Standard so the custom editor
  // opens on a valid set rather than on zeroes.
  pricingAnchors: PRICING_PRESETS.standard,
  startingAttitude: 50,
  // 100 gp per point of attitude. A party outfitting themselves at one Trader will shift it a
  // few points a session; a party buying a keep's worth of plate will shift it a lot.
  attitudeGainPerPoint: 10_000,
  attitudeGainCap: 5,
  archetypes: { list: [] },
  debug: false
};

/** The valid values of the `displayMode` setting, default first. */
export const DISPLAY_MODES = ["windowed", "fullscreen"];

/** Attitude is a percentage-like score; these are its hard bounds, not a preference. */
export const ATTITUDE_MIN = 0;
export const ATTITUDE_MAX = 100;

/* -------------------------------------------- */
/*  Setting accessors                           */
/* -------------------------------------------- */

/**
 * Read a module setting, falling back to its {@link DEFAULTS} entry if it is somehow not
 * registered yet.
 *
 * `game.settings.get` *throws* on an unregistered key, and a handful of callers (a logger, a
 * hook that can fire during another module's `init`) are reached early enough for that to be a
 * real risk. Returning the default is always the better failure mode than taking the caller down.
 * @param {string} key  A value from {@link SETTINGS}.
 * @returns {*}
 */
export function setting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return DEFAULTS[key];
  }
}

/**
 * The anchor set currently in force: the named preset, or the stored custom set.
 *
 * Guards a hand-edited or stale stored value by falling back to Standard — a broken anchor set
 * would otherwise price every item in the world wrongly, which is far worse than ignoring it.
 * @returns {{hostile: {buy: number, sell: number}, neutral: object, devoted: object}}
 */
export function pricingAnchors() {
  const preset = setting(SETTINGS.pricingPreset);
  if ( preset !== "custom" ) return PRICING_PRESETS[preset] ?? PRICING_PRESETS.standard;
  const stored = setting(SETTINGS.pricingAnchors);
  for ( const tier of ["hostile", "neutral", "devoted"] ) {
    const pair = stored?.[tier];
    if ( !Number.isFinite(pair?.buy) || !Number.isFinite(pair?.sell) ) {
      log("stored custom anchors are malformed; falling back to the Standard preset");
      return PRICING_PRESETS.standard;
    }
  }
  return stored;
}

/**
 * Whether the shop and manager windows cover the viewport rather than opening framed.
 *
 * Asks whether the mode is *not* windowed rather than whether it is fullscreen, so an unknown
 * or hand-edited stored value falls back to the takeover the CSS is primarily written for
 * rather than to a framed window whose layout was never checked against it.
 */
export function fullscreen() {
  return setting(SETTINGS.displayMode) !== "windowed";
}

/**
 * Whether the Ember module is active in this world. When it is, both windows wear Ember's look
 * (the `sogrom-ember` class, see styles/ember-skin.css), the same way the character creator does.
 * @returns {boolean}
 */
export function emberActive() {
  return !!game.modules?.get("ember")?.active;
}

/* -------------------------------------------- */
/*  Small helpers                               */
/* -------------------------------------------- */

/**
 * Localise one of this module's keys. The `MODULE_ID` prefix is added here so call sites read
 * as `t("manager.title")` rather than repeating the namespace.
 * @param {string} key            Key below the module's namespace in lang/en.json.
 * @param {object} [data]         Interpolation data; when given, `format` is used.
 * @returns {string}
 */
export function t(key, data) {
  const full = `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/**
 * The full path of one of this module's templates, for `PARTS` and `loadTemplates`.
 * @param {string} rel  Path below `templates/`, including the extension.
 * @returns {string}
 */
export function tpl(rel) {
  return `modules/${MODULE_ID}/templates/${rel}`;
}

/**
 * Debug log, silent unless the world has debug logging switched on.
 *
 * Deliberately reads the setting through {@link setting}, which swallows the
 * unregistered-key throw: this is called from `fireHook`, which a consumer could reach before
 * our `init` has run, and silence is the right failure mode for a logger.
 * @param {...*} args
 */
export function log(...args) {
  if ( !setting(SETTINGS.debug) ) return;
  console.log(`${MODULE_ID} |`, ...args);
}

/**
 * Clamp a number into a range, returning `min` for anything that isn't a finite number.
 *
 * Ours rather than `Math.clamped` because it also has to survive `undefined`, `null` and `"12"`
 * arriving from stored flags and form inputs.
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  const n = Number(value);
  if ( !Number.isFinite(n) ) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the ApplicationV2 options for a launch, based on the configured display mode, so the
 * shop and the Trader Manager feel identical. Windowed — the default — opens a themed,
 * draggable, resizable frame at ~92% of the screen, centred; fullscreen covers the viewport
 * with no chrome at all.
 *
 * Both windows are laid out for 1080p, so the windowed cap is deliberately generous: at that
 * size a framed window is very nearly the takeover anyway, which is what keeps the two modes
 * from needing two different layouts.
 * @returns {object}
 */
export function launchWindowOptions() {
  // Carry the base class explicitly: ApplicationV2 may replace (rather than merge) the static
  // DEFAULT_OPTIONS.classes with the array passed here.
  const classes = ["sogrom-shop", fullscreen() ? "sogrom-shop-fullscreen" : "sogrom-shop-windowed"];
  // With Ember active the windows wear its skin, so a shop reads as part of Ember's world rather
  // than a foreign UI dropped on top of it.
  if ( emberActive() ) classes.push("sogrom-ember");
  if ( fullscreen() ) return { classes };

  const w = Math.min(1880, Math.round(window.innerWidth * 0.92));
  const h = Math.min(1060, Math.round(window.innerHeight * 0.92));
  return {
    classes,
    window: { frame: true, positioned: true, resizable: true },
    position: {
      width: w,
      height: h,
      top: Math.max(4, Math.round((window.innerHeight - h) / 2)),
      left: Math.max(4, Math.round((window.innerWidth - w) / 2))
    }
  };
}
