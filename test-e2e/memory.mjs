/**
 * Look for memory the module keeps hold of, on the GM's client and a player's.
 *
 *   node memory.mjs                        # the main world, every phase
 *   node memory.mjs --cycles=100           # more repetitions, for a slower, surer answer
 *   node memory.mjs --only=trade,haggle    # phases whose key contains any of these
 *   HEADED=1 node memory.mjs               # watch it
 *
 * Kept out of `run.mjs` because it is slow on purpose: a leak only shows once the same thing has
 * been done many times over.
 *
 * ## How it decides
 *
 * Heap size alone is a poor witness. It moves with Foundry's own caches, V8's heuristics and
 * whatever else the world is doing, so a heap budget can only ever be generous. The sharper tests
 * are the ones a leak cannot hide from:
 *
 *  - **Live instances.** DevTools' `queryObjects` finds every object still alive with a given
 *    prototype, after a full collection. Close a shop fifty times and fifty ShopApps should be
 *    gone; one left over is a leak whatever the heap says. This is what caught the debug logger
 *    pinning every shop through the console.
 *  - **DOM counters.** Chrome's own count of live nodes and JS event listeners. A listener added
 *    per render, or a detached window kept alive, moves these by a fixed amount every cycle.
 *  - **Structural counts.** Hook listeners, registered applications and tracked shops must be
 *    the same after the cycles as before them.
 *  - **The template cache** must hold hollow templates and nothing else.
 *
 * The heap is still measured and reported for every phase, and appended to `memory-report.jsonl`
 * so one run can be compared with the next — which is how a fix is shown to have done something.
 *
 * Chat messages the phases post (receipts, haggle rolls, cards) are deleted before each
 * measurement: they are documents the table keeps on purpose, not memory the module holds.
 */

import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MODULE_ID, PLAYERS, WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld, worldInitialised } from "./lib/worlds.mjs";

const argv = process.argv.slice(2);
const flag = name => argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1];

const worldId = flag("world") ?? "magicshop";
const CYCLES = Math.max(5, Number(flag("cycles")) || 40);
const ONLY = flag("only")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
const WARMUP = 3;

/**
 * How much the heap may grow per cycle, after a full collection, before it counts as a leak. A
 * closed shop that stayed alive costs far more than this, so the allowance only has to absorb
 * noise and the lazy allocations Foundry makes the first few times anything happens.
 */
const BYTES_PER_CYCLE = 48 * 1024;
/** The floor under that allowance, since a small run's noise does not shrink with it. */
const HEAP_FLOOR = 2 * 1024 * 1024;
/**
 * DOM nodes that may appear over a phase. A leaked window is thousands of nodes a cycle; this only
 * covers Foundry's own lazily-built furniture (a tooltip, a notification) turning up once.
 */
const NODE_ALLOWANCE = 400;
/** JS event listeners that may appear over a phase, for the same reason. A leak adds one or more a cycle. */
const LISTENER_ALLOWANCE = 12;

const REPORT = fileURLToPath(new URL("memory-report.jsonl", import.meta.url));

/**
 * One client's heap and DOM, through the DevTools protocol.
 *
 * Playwright's own API has no garbage collection and no object census; a raw CDP session on the
 * page has both, and is what DevTools' Memory panel is built on.
 */
class Heap {

  /** @type {import("playwright").CDPSession} */ cdp;

  static async attach(session) {
    const heap = new Heap();
    heap.cdp = await session.page.context().newCDPSession(session.page);
    await heap.cdp.send("HeapProfiler.enable");
    return heap;
  }

  /** A full collection. Twice: the first pass frees what finalisers then let go. */
  async collect() {
    await this.cdp.send("HeapProfiler.collectGarbage");
    await this.cdp.send("HeapProfiler.collectGarbage");
  }

  /**
   * Bytes in use, DOM nodes and JS event listeners, after a full collection.
   *
   * Listeners on Foundry's shared tooltip element are left out of the count. Every right-click
   * menu anywhere in Foundry calls `game.tooltip.deactivate()`, which adds a one-shot
   * `transitionend` listener to `#tooltip`; with no tooltip showing there is no transition, so it
   * never fires and never goes (Foundry 14.368, `tooltip-manager.mjs#deactivate`). That is one
   * small closure per menu, it is Foundry's, and it would otherwise read as this module leaking a
   * listener per right-click.
   */
  async measure() {
    await this.collect();
    const { usedSize } = await this.cdp.send("Runtime.getHeapUsage");
    const { nodes, jsEventListeners } = await this.cdp.send("Memory.getDOMCounters");
    return { heap: usedSize, nodes, listeners: jsEventListeners - (await this.listenersOn("#tooltip")) };
  }

  /** How many listeners one element carries, or 0 if it is not there. */
  async listenersOn(selector) {
    const { result } = await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`
    });
    if ( !result.objectId ) return 0;
    const { listeners } = await this.cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
    await this.cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
    return listeners.length;
  }

  /**
   * How many objects with this module class's prototype are still alive.
   *
   * `queryObjects` collects before it counts, so anything it finds is genuinely reachable. The
   * class is imported from the very URL Foundry loaded it from, so it is the same class object and
   * the same prototype, not a second copy.
   * @param {"ShopApp"|"TraderManagerApp"} name
   */
  async live(name) {
    const file = name === "ShopApp" ? "shop-app.mjs" : "manager-app.mjs";
    const group = "sogrom-memory";
    try {
      const { result: proto } = await this.cdp.send("Runtime.evaluate", {
        expression: `import("/modules/${MODULE_ID}/scripts/app/${file}").then(m => m.${name}.prototype)`,
        awaitPromise: true,
        objectGroup: group
      });
      const { objects } = await this.cdp.send("Runtime.queryObjects", {
        prototypeObjectId: proto.objectId, objectGroup: group
      });
      const { result } = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: objects.objectId,
        functionDeclaration: "function() { return this.length; }",
        returnByValue: true
      });
      return result.value;
    } finally {
      await this.cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  }
}

if ( !WORLDS[worldId] ) {
  console.error(`Unknown world "${worldId}". Known: ${Object.keys(WORLDS).join(", ")}`);
  process.exit(1);
}
if ( !worldInitialised(worldId) ) {
  console.error(`World "${worldId}" has no database yet. Run: node provision.mjs ${worldId}`);
  process.exit(1);
}
ensureWorld(worldId);

console.log(`\n=== memory: ${WORLDS[worldId].title} (${worldId}), ${CYCLES} cycles ===`);

const server = await startFoundry(worldId);
const characterName = PLAYERS[0].character.name;
let gm = null;
let player = null;
let fixture = null;
let displayMode = null;
let failures = 0;
const failedRequests = new Set();
const record = { at: new Date().toISOString(), commit: gitHead(), world: worldId, cycles: CYCLES, phases: [] };

const check = (name, pass, detail = "") => {
  console.log(`       ${pass ? "ok" : "->"}  ${name}`);
  if ( !pass ) {
    failures++;
    if ( detail ) console.log(`           ${detail}`);
  }
  return pass;
};
const note = text => console.log(`       ..  ${text}`);

try {
  gm = await Session.open();
  player = await Session.open({ user: PLAYERS[0].name });
  console.log(`joined as ${gm.userName} and ${player.userName}`);
  const onGM = { who: "GM", session: gm, heap: await Heap.attach(gm) };
  const onPlayer = { who: "player", session: player, heap: await Heap.attach(player) };
  for ( const session of [gm, player] ) {
    session.page.on("response", response => {
      if ( response.status() >= 400 ) failedRequests.add(`${response.status()} ${decodeURI(response.url())}`);
    });
  }

  await gm.inWorld("provision.mjs", "cleanup");
  fixture = await gm.inWorld("memory.mjs", "setup", { characterName });
  const { traderId, actorId } = fixture;
  displayMode = await gm.inWorld("memory.mjs", "setDisplayMode", { mode: "windowed" });

  /* --- The generator's caches ---------------------------------------------
     Not a leak test. These caches are meant to live for the session; what matters is how much
     they cost, and that the template cache holds only what it uses. Run first, so the phases
     below measure against a heap that already has them. */
  if ( selected("caches") ) {
    console.log("\n[    ] generator caches (GM)");
    await gm.inWorld("memory.mjs", "dropCaches");
    await gm.inWorld("memory.mjs", "flushPacks");
    const empty = await onGM.heap.measure();
    const pool = await gm.inWorld("memory.mjs", "buildPool");
    const full = await onGM.heap.measure();
    const again = await gm.inWorld("memory.mjs", "buildPool");
    const reused = await onGM.heap.measure();
    // Right after a build, Foundry's own pack cache holds every document the build loaded, so the
    // figure above cannot tell who is keeping what. Five minutes later Foundry lets its copies go;
    // what is left then is the module's for the rest of the session.
    await gm.inWorld("memory.mjs", "flushPacks");
    const settled = await onGM.heap.measure();
    record.caches = {
      pool, costBytes: full.heap - empty.heap, secondBuildBytes: reused.heap - full.heap,
      heldAfterFlushBytes: settled.heap - empty.heap
    };
    note(`pool: ${pool.poolSize} entries (${Object.entries(pool.kinds).map(([k, n]) => `${n} ${k}`).join(", ")}), built in ${pool.ms} ms`);
    note(`template cache: ${pool.checked} candidates checked, ${pool.held} documents held`);
    note(`caches cost ${mb(full.heap - empty.heap)} on the GM's heap just after a build (Foundry's pack cache included)`);
    note(`and ${mb(settled.heap - empty.heap)} once Foundry's pack cache has let go: the module's share, for the session`);
    check("the template cache holds only hollow templates", pool.stray === 0,
      `${pool.stray} of ${pool.held} held documents are finished items, not templates`);
    check("building the pool a second time reuses the cache",
      again.ms < pool.ms && reused.heap - full.heap < HEAP_FLOOR,
      `second build ${again.ms} ms, heap ${mb(reused.heap - full.heap)}`);
  }

  /* --- Every way a table uses the module, over and over --------------------
     Each phase names who does the work and which clients to watch. A player's shop is watched on
     both sides at once: the window lives on the player's client, but every open is a query the
     GM answers, so the GM's request path is exercised by the same cycles. */
  const both = [onPlayer, onGM];
  const few = Math.max(3, Math.round(CYCLES / 4));
  const fewer = Math.max(3, Math.round(CYCLES / 8));
  const P = (fn, arg) => player.inWorld("memory.mjs", fn, { traderId, ...arg });
  const G = (fn, arg) => gm.inWorld("memory.mjs", fn, { traderId, ...arg });

  const PHASES = [
    {
      key: "player-open", label: "a player opens and closes a shop", cycles: CYCLES, watch: both,
      run: n => P("shopCycles", { cycles: n })
    },
    {
      key: "player-use", label: "a player uses every control in a shop", cycles: few, watch: both,
      run: n => P("shopUsed", { cycles: n })
    },
    {
      key: "player-trade-window", label: "a player buys through the window", cycles: few, watch: both,
      run: n => P("shopConfirm", { cycles: n })
    },
    {
      key: "player-trade-api", label: "a player buys and sells back through the API", cycles: few, watch: both,
      run: n => P("apiTrades", { cycles: n })
    },
    {
      key: "player-haggle", label: "a player haggles", cycles: few, watch: both,
      before: () => gm.inWorld("features.mjs", "holdDice", { face: 20 }),
      after: () => gm.inWorld("features.mjs", "releaseDice"),
      run: n => P("haggleCycles", { cycles: n })
    },
    {
      key: "player-drag-sell", label: "a player drags goods about and sells through the window", cycles: few, watch: both,
      run: n => P("dragAndSell", { cycles: n })
    },
    {
      key: "player-payer", label: "a player pays from the party purse", cycles: few, watch: both,
      run: n => P("payerCycles", { cycles: n, groupId: fixture.groupId })
    },
    {
      key: "player-settings", label: "an open shop follows the GM changing the pricing preset", cycles: few, watch: both,
      run: async n => {
        const held = await P("openAndHold");
        const changed = await G("settingChanges", { cycles: n });
        const open = await player.inWorld("memory.mjs", "openShopCount");
        await player.inWorld("memory.mjs", "closeShops");
        return { done: held.open && open === 1 ? changed.done : 0 };
      }
    },
    {
      key: "player-view", label: "a player views an item from the menu", cycles: few, watch: [onPlayer],
      run: n => P("viewItemCycles", { cycles: n, viewName: fixture.viewName })
    },
    {
      key: "player-live", label: "an open shop follows the world changing under it", cycles: CYCLES, watch: both,
      run: async n => {
        const held = await P("openAndHold");
        const changed = await G("worldChanges", { cycles: n });
        const open = await player.inWorld("memory.mjs", "openShopCount");
        await player.inWorld("memory.mjs", "closeShops");
        return { done: held.open && open === 1 ? changed.done : 0 };
      }
    },
    {
      key: "player-show", label: "the GM shows the Trader to the players", cycles: few, watch: both,
      run: async n => {
        let done = 0;
        for ( let i = 0; i < n; i++ ) {
          await G("showOnce");
          const opened = await waitFor(() => player.inWorld("memory.mjs", "openShopCount"), c => c === 1);
          await player.inWorld("memory.mjs", "closeShops");
          if ( opened ) done++;
        }
        return { done };
      }
    },
    {
      key: "player-card", label: "the GM posts the Trader's chat card", cycles: few, watch: both,
      run: n => G("cardCycles", { cycles: n })
    },
    {
      key: "fullscreen", label: "full-screen shops, closed with Escape", cycles: few, watch: both,
      before: () => G("setDisplayMode", { mode: "fullscreen" }),
      after: () => G("setDisplayMode", { mode: "windowed" }),
      run: async n => {
        const mine = await P("shopCycles", { cycles: n, viaEscape: true });
        const gms = await G("shopCycles", { cycles: n, viaEscape: true, actorId });
        return { done: Math.min(mine.done, gms.done) };
      }
    },
    {
      key: "gm-open", label: "the GM opens and closes a shop", cycles: CYCLES, watch: [onGM],
      run: n => G("shopCycles", { cycles: n, actorId })
    },
    {
      key: "gm-use", label: "the GM uses every control in a shop", cycles: few, watch: [onGM],
      run: n => G("shopUsed", { cycles: n, actorId })
    },
    {
      key: "manager-open", label: "the GM opens and closes the manager", cycles: CYCLES, watch: [onGM],
      run: n => G("managerCycles", { cycles: n })
    },
    {
      key: "manager-use", label: "the GM uses the manager's tabs, dialogs and sheets", cycles: few, watch: [onGM],
      flushPacks: true,
      run: n => G("managerUsed", { cycles: n })
    },
    {
      key: "manager-crud", label: "the GM duplicates, exports, imports and saves archetypes", cycles: few, watch: [onGM],
      run: n => G("managerCrud", { cycles: n })
    },
    {
      key: "generate", label: "the GM stocks a Trader from an archetype", cycles: fewer, watch: [onGM],
      flushPacks: true,
      run: n => G("generateCycles", { cycles: n })
    },
    {
      key: "restock", label: "world time runs past a restock", cycles: few, watch: both,
      run: n => G("restockCycles", { cycles: n })
    }
  ];

  for ( const phase of PHASES ) {
    if ( !selected(phase.key) ) continue;
    console.log(`\n[    ] ${phase.label} (${phase.key}), ${phase.cycles} times`);
    try {
      await runPhase(phase);
    } catch ( err ) {
      check(`the phase ran to the end`, false, err.message.split("\n")[0]);
    } finally {
      await phase.after?.().catch(() => {});
    }
  }

  // The world's console is an assertion here too: a window that fails to close cleanly throws.
  //
  // Failed requests are judged by URL rather than by the console line, which never names the
  // file. The compendium browser the manager opens draws art for every item in every pack, and a
  // content pack whose artwork is not installed 404s there on every visit; that is the pack's
  // problem, noted but not failed. A 404 for one of this module's own files is ours.
  console.log("\n[    ] console");
  const failedRequest = /^\[error\] Failed to load resource: the server responded with a status of \d+/;
  for ( const session of [gm, player] ) {
    const errors = session.errors().filter(line => !failedRequest.test(line));
    check(`${session.userName}'s client logged no errors`, !errors.length,
      errors.slice(0, 3).map(l => l.split("\n")[0]).join(" | "));
  }
  const ours = [...failedRequests].filter(line => line.includes(`/modules/${MODULE_ID}/`));
  check("no request for one of this module's files failed", !ours.length, ours.slice(0, 5).join(" | "));
  for ( const line of [...failedRequests].filter(l => !ours.includes(l)).slice(0, 5) ) {
    note(`not ours: ${line}`);
  }
} catch ( err ) {
  failures++;
  console.error(`\nRUN FAILED: ${err.message}`);
  if ( err.stack ) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  if ( gm ) console.error(`\n--- GM console tail ---\n${gm.tail(30)}`);
} finally {
  if ( gm && displayMode ) await gm.inWorld("memory.mjs", "setDisplayMode", { mode: displayMode }).catch(() => {});
  if ( gm && fixture ) {
    await gm.inWorld("memory.mjs", "teardown", { ...fixture, characterName }).catch(() => {});
  }
  await player?.close().catch(() => {});
  if ( gm ) await gm.close({ returnToSetup: true }).catch(() => {});
  await server.stop();
}

record.failures = failures;
try {
  appendFileSync(REPORT, `${JSON.stringify(record)}\n`);
  console.log(`\nappended to ${REPORT}`);
} catch ( err ) {
  console.log(`\ncould not write the report: ${err.message}`);
}

console.log(failures ? `\n${failures} failure(s).\n` : "\nAll green.\n");
process.exit(failures ? 1 : 0);

/* -------------------------------------------- */

/**
 * Warm up, measure, run the cycles, tidy the chat, measure again, and judge.
 *
 * The warm-up matters: the first few times anything opens, Foundry builds things it keeps for the
 * session (templates compiled, a tooltip element, an index). Those are not leaks and they would
 * otherwise be charged to the first phase that happens to trigger them.
 */
async function runPhase(phase) {
  await phase.before?.();
  const mark = await gm.inWorld("memory.mjs", "chatMark");
  await phase.run(Math.min(WARMUP, phase.cycles));
  await gm.inWorld("memory.mjs", "chatPurge", { keep: mark });
  // Phases that load compendium documents leave them in Foundry's pack cache for five minutes,
  // and a random pick loads different ones each cycle. Empty it first, as Foundry itself would, so
  // only what the module holds is counted.
  if ( phase.flushPacks ) await gm.inWorld("memory.mjs", "flushPacks");
  await gm.page.waitForTimeout(300);

  const before = [];
  for ( const w of phase.watch ) {
    before.push({ probe: await w.session.inWorld("memory.mjs", "probe"), ...(await w.heap.measure()) });
  }

  const { done } = await phase.run(phase.cycles);
  const purged = await gm.inWorld("memory.mjs", "chatPurge", { keep: mark });
  if ( phase.flushPacks ) await gm.inWorld("memory.mjs", "flushPacks");
  await gm.page.waitForTimeout(300);
  check(`every cycle ran to the end (${done}/${phase.cycles})`, done === phase.cycles);
  if ( purged ) note(`${purged} chat message(s) it posted were deleted before measuring`);

  const allowance = Math.max(HEAP_FLOOR, phase.cycles * BYTES_PER_CYCLE);
  for ( const [i, w] of phase.watch.entries() ) {
    const now = await w.heap.measure();
    const probe = await w.session.inWorld("memory.mjs", "probe");
    const live = { ShopApp: await w.heap.live("ShopApp"), TraderManagerApp: await w.heap.live("TraderManagerApp") };
    const was = before[i];
    const grown = { heap: now.heap - was.heap, nodes: now.nodes - was.nodes, listeners: now.listeners - was.listeners };
    record.phases.push({ phase: phase.key, client: w.who, cycles: phase.cycles, before: was.heap, after: now.heap,
      ...grown, perCycle: Math.round(grown.heap / phase.cycles), live });

    const on = `[${w.who}]`;
    // A context menu keeps the last window it opened on until the next one opens anywhere, so a
    // single survivor is Foundry's, not ours. Two is a pattern.
    for ( const [cls, count] of Object.entries(live) ) {
      check(`${on} no closed ${cls} is still alive (${count})`, count <= 1,
        `${count} instances survived a full collection after ${phase.cycles} cycles`);
    }
    check(`${on} no hook listeners were added`, probe.hookTotal === was.probe.hookTotal,
      diffHooks(was.probe.hooks, probe.hooks));
    check(`${on} no application stayed registered`, probe.applications === was.probe.applications,
      `${was.probe.applications} -> ${probe.applications}`);
    check(`${on} no shop stayed tracked`, probe.trackedShops === 0, `${probe.trackedShops} tracked`);
    check(`${on} no window markup was left in the page`, probe.shopElements === was.probe.shopElements,
      `${was.probe.shopElements} -> ${probe.shopElements}`);
    check(`${on} DOM nodes ${signed(grown.nodes)} (allowed ${NODE_ALLOWANCE})`, grown.nodes <= NODE_ALLOWANCE,
      `${was.nodes} -> ${now.nodes}`);
    check(`${on} event listeners ${signed(grown.listeners)} (allowed ${LISTENER_ALLOWANCE})`,
      grown.listeners <= LISTENER_ALLOWANCE, `${was.listeners} -> ${now.listeners}`);
    check(`${on} heap ${signed(grown.heap, mb)}, ${kb(grown.heap / phase.cycles)} a cycle (allowed ${mb(allowance)})`,
      grown.heap <= allowance);
  }
}

/** Whether a phase is in `--only`, which matches on any part of its key. */
function selected(key) {
  return !ONLY || ONLY.some(part => key.includes(part));
}

/** Poll an async reading until it passes, for up to five seconds. */
async function waitFor(read, test, ms = 5000) {
  for ( const end = Date.now() + ms; Date.now() < end; ) {
    if ( test(await read()) ) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

function diffHooks(before, after) {
  const changed = [];
  for ( const event of new Set([...Object.keys(before), ...Object.keys(after)]) ) {
    const a = before[event] ?? 0;
    const b = after[event] ?? 0;
    if ( a !== b ) changed.push(`${event}: ${a} -> ${b}`);
  }
  return changed.join(", ");
}

function gitHead() {
  try {
    const head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "+dirty" : "";
    return head + dirty;
  } catch {
    return null;
  }
}

function signed(value, format = String) {
  return `${value >= 0 ? "+" : "-"}${format(Math.abs(value))}`;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
