/**
 * A browser session joined to the active world as a named user.
 *
 * Playwright's only job here is to *be a client*: launch Chromium, log in, and hand back a page
 * whose JS context has `game`, `CONFIG`, `dnd5e` and the live documents. Every actual assertion
 * runs inside that context via {@link Session#eval} — there are no selectors for game UI on this
 * side, because driving Foundry through its own objects is far more stable than through its DOM.
 *
 * **Unlike the Character Creator's harness, this one is parameterised by user.** That harness
 * hard-codes the single auto-created Gamemaster, which is all a character builder needs. The
 * Magic Shop's whole architecture is a GM/player boundary, so its suites open two or three
 * sessions at once and assert across them.
 */

import { chromium } from "playwright";
import { BASE_URL, GM_USER, HEADED, WORLD_READY_TIMEOUT_MS } from "../config.mjs";

/**
 * Console lines that are not this module's fault, each with the reason it appears.
 *
 * Deliberately a documented list rather than a loose regex. A blanket "ignore errors mentioning
 * chat" would hide real faults; naming the mechanism means the next person can tell whether an
 * exclusion still applies, and delete it when it does not.
 */
const KNOWN_NOISE = [
  {
    // Foundry's canvas is disabled in this harness (see `open()`), and the WebGL context it
    // still probes for complains.
    pattern: /WebGL|CONTEXT_LOST/i,
    why: "the canvas is switched off in this harness"
  },
  {
    pattern: /favicon/i,
    why: "the headless client has no favicon to fetch"
  },
  {
    // Foundry's own bug, not ours: `ChatLog#postNotification` reaches into a chat-notifications
    // element that a headless client never renders, and throws while appending its placeholder.
    // Triggered by any `ChatMessage.create`, so every receipt the trade suites post hits it.
    // The message itself is created correctly — only Foundry's toast fails.
    pattern: /Cannot set properties of null \(setting 'hidden'\)/,
    why: "Foundry's chat-notification toast has no element to render into here"
  },
  {
    // Provoked on purpose by `in-world/trade.mjs#raceSuite`: two settlements race for the last
    // item on a shelf, and Foundry logs the loser's failed delete. Exactly one winning is the
    // assertion; this line is the sound of the other one losing.
    pattern: /Item "[A-Za-z0-9]+" does not exist/,
    why: "the race suite deliberately makes one of two settlements lose"
  },
  {
    // Provoked on purpose by `in-world/cross.mjs#inspectAsPlayer`, which tries to write to a
    // Trader as a player to prove it cannot.
    pattern: /lacks permission to update Actor/,
    why: "the cross-client suite deliberately attempts a forbidden write"
  }
];

export class Session {

  /** @type {import("playwright").Browser} */ browser;
  /** @type {import("playwright").BrowserContext} */ context;
  /** @type {import("playwright").Page} */ page;

  /** The user this session is logged in as. */
  userName;

  /** Console and pageerror lines from the world, newest last. Surfaced when something fails. */
  consoleLog = [];

  constructor(browser, context, page, userName) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.userName = userName;
  }

  /**
   * Launch a browser and join the active world as `user`.
   * @param {object} [options]
   * @param {string} [options.user]      Defaults to the Gamemaster.
   * @param {object} [options.viewport]  Client size. The default is the design width.
   * @param {number} [options.deviceScaleFactor]
   * @param {boolean} [options.canvas]   Leave Foundry's canvas on.
   * @returns {Promise<Session>}
   */
  static async open({
    user = GM_USER,
    viewport = { width: 1920, height: 1080 },
    deviceScaleFactor = 1,
    canvas = false
  } = {}) {
    const browser = await chromium.launch({
      headless: !HEADED,
      args: [
        // Foundry leans on WebGL; SwiftShader keeps it working headlessly. Kept even though the
        // canvas is disabled below, because HEADED runs and screenshots can turn it back on.
        "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio",
        // Headroom: building the item pool walks every compendium in several content packs, and
        // a headless renderer's default heap is small enough to die doing it.
        "--js-flags=--max-old-space-size=4096",
        // Chromium's default /dev/shm is small and it falls back to disk noisily under memory
        // pressure. Harmless otherwise, and one less way for the renderer to fall over.
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await context.newPage();
    const session = new Session(browser, context, page, user);

    page.on("console", msg => session.consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    // Keep the stack: a bare message rarely identifies which package threw.
    page.on("pageerror", err =>
      session.consoleLog.push(`[pageerror] ${err.message}\n${err.stack ?? ""}`));

    // Foundry's render pipeline is promise-based, so a failing application render surfaces as an
    // *unhandled rejection* which never fires `pageerror` — the window just stays half-drawn.
    // Route those to the console so they land in `consoleLog` too.
    await page.addInitScript(() => {
      addEventListener("unhandledrejection", event => {
        const reason = event.reason;
        console.error(`[unhandledrejection] ${reason?.message ?? reason}\n${reason?.stack ?? ""}`);
      });
    });

    // Turn the canvas off before the world loads.
    //
    // Nothing here looks at the board. Under headless Chromium the canvas is served by
    // SwiftShader — *software* WebGL — and drawing the full canvas group stack is enough to lose
    // the GL context outright and crash the page during world load, before any test runs.
    //
    // It has to be done here, in the browser, not with `game.settings.set` after joining:
    // `core.noCanvas` is registered `scope: "client"`, so it lives in `localStorage` and a fresh
    // Playwright context starts empty every run. `addInitScript` runs before page scripts on
    // every navigation, which is early enough. The value is the cleaned JSON Foundry writes.
    if ( !canvas ) {
      await page.addInitScript(() => {
        try { window.localStorage.setItem("core.noCanvas", "true"); } catch { /* blocked */ }
      });
    }

    // One retry: the very first join after a cold server start can land while the server is
    // still finishing its own wiring, and a second attempt just works.
    for ( let attempt = 1; ; attempt++ ) {
      try {
        await session.join();
        return session;
      } catch ( err ) {
        if ( attempt >= 2 ) {
          await browser.close().catch(() => {});
          throw err;
        }
        session.consoleLog.push(`[harness] join attempt ${attempt} failed, retrying: ${err.message}`);
        await page.waitForTimeout(5000);
      }
    }
  }

  /**
   * Load the join page, authenticate, and wait for the world.
   *
   * *How* you name the user depends on the world's join-screen theme, and both shapes are live:
   * the classic screen renders a `<select name="userid">` of every user, while the minimal theme
   * renders a free-text `<input name="username">`. Waiting on the select alone times out against
   * a minimal-themed world with an error naming only the missing locator, which reads as though
   * the world failed to launch when it is up and serving.
   */
  async join() {
    await this.page.goto(`${BASE_URL}/join`, { waitUntil: "domcontentloaded" });

    const select = this.page.locator("select[name=userid]");
    const username = this.page.locator("input[name=username]");
    await Promise.race([
      select.waitFor({ timeout: 30_000 }),
      username.waitFor({ timeout: 30_000 })
    ]).catch(() => {
      throw new Error("The join form never appeared — neither select[name=userid] nor "
        + `input[name=username]. Page: ${this.page.url()}`);
    });

    if ( await select.count() ) await select.selectOption({ label: this.userName });
    else await username.fill(this.userName);
    await this.page.locator("button[name=join]").click();

    await this.waitForReady();
  }

  /** Block until the world's `game` object reports ready. */
  async waitForReady() {
    try {
      await this.page.waitForFunction(() => globalThis.game?.ready === true, null, {
        timeout: WORLD_READY_TIMEOUT_MS,
        polling: 250
      });
    } catch ( err ) {
      // A bare "timeout" says nothing about *why* the world never came up, so pull the client's
      // own view of where it got stuck before re-throwing.
      const state = await this.page.evaluate(() => ({
        url: location.href,
        hasGame: typeof globalThis.game,
        ready: globalThis.game?.ready ?? null,
        world: globalThis.game?.world?.id ?? null,
        user: globalThis.game?.user?.name ?? null,
        body: document.body?.innerText?.slice(0, 800) ?? null
      })).catch(e => ({ evaluateFailed: e.message }));
      throw new Error(`World never reached game.ready as "${this.userName}".\n`
        + `client state: ${JSON.stringify(state, null, 2)}\n`
        + `--- console tail ---\n${this.tail(60)}`, { cause: err });
    }
    await this.page.waitForTimeout(800);
  }

  /**
   * Run a function inside the world and return its JSON-serialisable result.
   * @param {Function} fn   Executed in the page; receives `arg`.
   * @param {*} [arg]
   * @returns {Promise<*>}
   */
  async eval(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /**
   * Import one of the harness's in-world modules and call an export on it.
   *
   * The module under test is junction-linked into `Data/modules`, so Foundry serves this
   * directory over HTTP like any other module file — which is what lets the in-world half be
   * real ES modules importing the module under test directly, rather than strings of code
   * pasted through `evaluate`.
   * @param {string} file    File name under `in-world/`.
   * @param {string} exportName
   * @param {*} [arg]
   * @returns {Promise<*>}
   */
  async inWorld(file, exportName, arg) {
    return this.page.evaluate(async ({ file, exportName, arg }) => {
      const url = `/modules/sogrom-simple-dnd5e-magic-shop/test-e2e/in-world/${file}`;
      const module = await import(url);
      if ( typeof module[exportName] !== "function" ) {
        throw new Error(`${file} has no exported function "${exportName}"`);
      }
      return module[exportName](arg);
    }, { file, exportName, arg });
  }

  /** The last `n` console lines, for a failure report. */
  tail(n = 40) {
    return this.consoleLog.slice(-n).join("\n");
  }

  /**
   * Any console line that looks like a real error, for the run's own assertion.
   *
   * The world's console *is* an assertion: a suite can pass every check and still have left a
   * trail of thrown promises behind it. So anything excluded here has to be justified, and each
   * exclusion below names what produces it.
   */
  errors() {
    return this.consoleLog.filter(line => {
      if ( !/^\[(error|pageerror|unhandledrejection)\]/.test(line) ) return false;
      return !KNOWN_NOISE.some(({ pattern }) => pattern.test(line));
    });
  }

  /** Return the world to setup, which is what closes the database cleanly, then shut down. */
  async close({ returnToSetup = false } = {}) {
    if ( returnToSetup ) {
      await this.eval(() => game.shutDown?.()).catch(() => {});
      await this.page.waitForTimeout(1500);
    }
    await this.browser.close().catch(() => {});
  }
}
