/**
 * Configuration for the end-to-end harness — **copy this to `config.mjs` and edit the paths**.
 *
 * The harness drives a *real* Foundry install against *real* content modules, so the paths below
 * are specific to the machine it runs on. `config.mjs` is gitignored for that reason; this file
 * is the tracked template.
 */

/** Where Foundry Virtual Tabletop itself is installed (the dir holding `main.mjs`). */
export const FOUNDRY_ROOT = "C:/FoundryVTT";

/** Foundry's user data root (the dir holding `Data/`, `Config/`, `Logs/`). */
export const DATA_PATH = "C:/Users/<you>/AppData/Local/FoundryVTT";

/** Foundry's `Data/` dir, where worlds/modules/systems live. */
export const DATA_DIR = `${DATA_PATH}/Data`;

/**
 * Port for the harness's own Foundry instance.
 *
 * Deliberately none of: 30000 (a Foundry the user already has running), or 30099 (the Simple
 * D&D Character Creator's harness). All three can coexist in a config even though Foundry's
 * data-directory lock means only one may actually run at a time.
 */
export const PORT = 30098;

export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The module under test, junction-linked into `Data/modules` by `npm run link-module`. */
export const MODULE_ID = "sogrom-simple-dnd5e-magic-shop";

/** The repo root, i.e. the junction target. */
export const MODULE_SOURCE = "H:/Code/FoundryModules/Simple-DnD-Magic-Shop";

/**
 * Content modules enabled in the main test world, beyond the module under test.
 *
 * These are the packs the stock generator draws from. Dropping one is fine — the generator
 * reports what it could not find — but the suites that assert on pool sizes assume this set.
 */
export const CONTENT_MODULES = [
  "dnd-players-handbook",
  "dnd-dungeon-masters-guide",
  "sogrom-baldurs-gate-3-5e",
  "sogrom-griffons-saddlebag"
];

/** The system the test worlds run, and the version this harness was written against. */
export const SYSTEM = "dnd5e";
export const SYSTEM_VERSION = "6.0.1";
export const CORE_VERSION = "14.367";

/**
 * The test worlds. `id` doubles as the directory name under `Data/worlds`.
 *
 * `magicshop`       — the main suite: the module plus content packs, with a GM and two player
 *                     users so the GM/player boundary can actually be exercised.
 * `magicshop-bare`  — the module alone. Asserts graceful behaviour with no compendia to stock
 *                     from, and boots fast for suites that need no content.
 */
export const WORLDS = {
  magicshop: {
    id: "magicshop",
    title: "Magic Shop",
    description: "<p>Automated harness for the Simple D&amp;D Magic Shop. Content is "
      + "disposable — traders and characters are created and deleted per run.</p>",
    modules: [MODULE_ID, ...CONTENT_MODULES]
  },
  "magicshop-bare": {
    id: "magicshop-bare",
    title: "Magic Shop (bare)",
    description: "<p>The Magic Shop with no content modules, for the empty-pool cases.</p>",
    modules: [MODULE_ID]
  }
};

/**
 * The users every test world gets.
 *
 * **This is the part that differs from the Character Creator's harness**, and it is the whole
 * reason this one exists in its own right. That harness has a single auto-created Gamemaster,
 * which is enough to test a character builder. The Magic Shop is a GM-authoritative boundary
 * crossed by player intent, so the things most worth testing — that a forged price is refused,
 * that hidden stock never reaches a player's browser, that two players racing for the last item
 * cannot both win — are invisible with one client.
 *
 * Two players rather than one, with deliberately opposite Charisma: the price divergence between
 * them is then directly observable, and a race needs two.
 */
export const GM_USER = "Gamemaster";

export const PLAYERS = [
  {
    name: "Player One",
    character: { name: "[e2e] Vex", cha: 20 }
  },
  {
    name: "Player Two",
    character: { name: "[e2e] Thog", cha: 10 }
  }
];

/** Set true to watch the browser drive Foundry. `HEADED=1 npm run …` also flips it. */
export const HEADED = process.env.HEADED === "1";

/** How long to wait for the Foundry server to accept connections, and for `game.ready`. */
export const SERVER_TIMEOUT_MS = 120_000;
export const WORLD_READY_TIMEOUT_MS = 90_000;
