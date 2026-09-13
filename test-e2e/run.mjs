/**
 * Run the end-to-end suites against a real Foundry world.
 *
 *   node run.mjs                       # the main world, every suite
 *   node run.mjs --only=context,card   # just these
 *   node run.mjs --world=magicshop-bare
 *   node run.mjs --hold                # leave the browser open at the end
 *   HEADED=1 node run.mjs              # watch it
 *
 * Exits non-zero if any assertion fails, or if the world logged an error, so this is usable in
 * a pre-release check rather than only by eye.
 */

import { MODULE_ID, PLAYERS, WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld, worldInitialised } from "./lib/worlds.mjs";

const argv = process.argv.slice(2);
const flag = name => argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1];
const has = name => argv.includes(`--${name}`);

const worldId = flag("world") ?? "magicshop";
const only = flag("only")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;

if ( !WORLDS[worldId] ) {
  console.error(`Unknown world "${worldId}". Known: ${Object.keys(WORLDS).join(", ")}`);
  process.exit(1);
}
if ( !worldInitialised(worldId) ) {
  console.error(`World "${worldId}" has no database yet. Run: node provision.mjs ${worldId}`);
  process.exit(1);
}
ensureWorld(worldId);

console.log(`\n=== ${WORLDS[worldId].title} (${worldId}) ===`);

const server = await startFoundry(worldId);
let gm = null;
let players = [];
let failed = 0;

try {
  gm = await Session.open();
  console.log(`joined as ${gm.userName}`);

  // The whole reason this harness exists in its own right: real player clients, joined
  // alongside the GM, so the GM/player boundary is exercised rather than assumed. The GM
  // client is what answers their queries, so it has to be up first.
  for ( const spec of PLAYERS ) {
    const session = await Session.open({ user: spec.name });
    players.push(session);
    console.log(`joined as ${session.userName}`);
  }

  const active = await gm.eval(() => game.users.filter(u => u.active).map(u => u.name));
  console.log(`active users: ${active.join(", ")}`);
  if ( active.length < PLAYERS.length + 1 ) {
    throw new Error(`Only ${active.length} clients connected; expected ${PLAYERS.length + 1}.`);
  }

  // Clear anything a previous run left behind before asserting on anything. A run that died
  // halfway skipped its own teardown, and its leftovers would otherwise sort ahead of this run's
  // fixtures — the manager suite, for one, reads whichever Trader is first in the rail.
  const swept = await gm.inWorld("provision.mjs", "cleanup");
  if ( swept.removed.length ) {
    console.log(`swept ${swept.removed.length} leftover(s) from an earlier run: `
      + swept.removed.join(", "));
  }

  /* --- The in-world suites, run on the GM's client -------------------------
     The GM is the authority, so that is where the context builder and the document writes
     belong. The player clients matter for what they can *reach*, which the query suite below
     exercises across the socket. */
  const results = await gm.inWorld("harness.mjs", "all");
  failed += report(results, only);

  // Settlement lives in its own file: it is the half of the module that moves things of value,
  // and it is worth being able to run on its own.
  const trades = await gm.inWorld("trade.mjs", "all");
  failed += report(trades, only);

  // The API and the hook surface: docs/API.md is a promise to other module authors, and this is
  // what stops it rotting.
  const api = await gm.inWorld("api.mjs", "all");
  failed += report(api, only);

  // Do the windows actually draw? Nothing else here opens one, so a broken Handlebars
  // expression or a renamed context field would otherwise reach a player unchallenged.
  const rendered = await gm.inWorld("render.mjs", "all");
  failed += report(rendered, only);

  /* --- The one thing only a second client can show ------------------------- */
  failed += await crossClientChecks(gm, players);

  /* --- The world's own console is an assertion ----------------------------- */
  for ( const session of [gm, ...players] ) {
    const errors = session.errors();
    if ( !errors.length ) continue;
    failed++;
    console.log(`\n  FAIL  ${session.userName}'s client logged ${errors.length} error(s):`);
    for ( const line of errors.slice(0, 8) ) console.log(`        ${line.split("\n")[0]}`);
  }

  if ( has("hold") ) {
    console.log("\n--hold: browsers left open. Ctrl+C to finish.");
    await new Promise(() => {});
  }
} catch ( err ) {
  failed++;
  console.error(`\nRUN FAILED: ${err.message}`);
  if ( err.stack ) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  if ( gm ) console.error(`\n--- GM console tail ---\n${gm.tail(30)}`);
} finally {
  for ( const session of players ) await session.close().catch(() => {});
  if ( gm ) await gm.close({ returnToSetup: true }).catch(() => {});
  await server.stop();
}

console.log(failed ? `\n${failed} failure(s).\n` : "\nAll green.\n");
process.exit(failed ? 1 : 0);

/* -------------------------------------------- */

/**
 * Print one suite report and count its failures.
 * @param {Record<string, {total: number, failed: number, cases: object[]}>} results
 * @param {string[]|null} only
 * @returns {number}
 */
function report(results, only) {
  let failures = 0;
  for ( const [suite, result] of Object.entries(results) ) {
    if ( only && !only.includes(suite) ) continue;
    const mark = result.failed ? "FAIL" : " ok ";
    console.log(`\n[${mark}] ${suite} — ${result.total - result.failed}/${result.total}`);
    for ( const item of result.cases ) {
      if ( item.pass ) {
        console.log(`       ok  ${item.name}`);
      } else {
        failures++;
        console.log(`       ->  ${item.name}`);
        for ( const line of String(item.detail).split("\n").slice(0, 4) ) {
          if ( line.trim() ) console.log(`           ${line}`);
        }
      }
    }
  }
  return failures;
}

/**
 * The assertions that need two clients in the same world at once.
 *
 * Everything else could in principle be done on one client. These cannot: a player's browser
 * genuinely cannot see a Trader, and the only way to prove that is to ask a player's browser.
 * @param {Session} gm
 * @param {Session[]} players
 * @returns {Promise<number>}  Failure count.
 */
async function crossClientChecks(gm, players) {
  let failures = 0;
  // Returns whether it passed, so a check can guard the ones that depend on it.
  const check = (name, pass, detail = "") => {
    if ( pass ) {
      console.log(`       ok  ${name}`);
      return true;
    }
    failures++;
    console.log(`       ->  ${name}`);
    if ( detail ) console.log(`           ${detail}`);
    return false;
  };

  console.log("\n[    ] cross-client");

  // A Trader for the players to look at, made by the GM.
  const traderId = await gm.inWorld("cross.mjs", "makeSharedTrader");
  const player = players[0];
  if ( !player ) {
    check("a player client is connected", false);
    return failures;
  }

  const seen = await player.inWorld("cross.mjs", "inspectAsPlayer", { traderId, module: MODULE_ID });

  check("a player cannot open the Trader's sheet",
    seen.cannotOpenSheet === true, "a player had observer rights on a Trader");
  check("a player cannot write to the Trader",
    seen.cannotWrite === true, "a player was able to edit a Trader's purse");
  check("a player's client can reach the shop through the GM",
    seen.contextOk === true, seen.error ?? "");
  check("the context it receives is priced", seen.firstPrice > 0, `price=${seen.firstPrice}`);
  check("gated stock is filtered out of the payload the GM builds",
    seen.sawGated === false, "a reveal-gated line was in the payload");
  check("a forged actor id is refused across the socket",
    seen.forgedRefused === true, seen.forgedDetail ?? "");

  // Recorded, not asserted: Foundry replicates the whole Actor to every client, so a player's
  // browser does hold the Trader's items. Reveal-at-attitude is a table-facing feature, not a
  // secrecy control — see docs/PLAN.md §6.
  console.log(`       ..  note: ${seen.replicatedItemCount} trader items are replicated to the `
    + "player's client (Foundry always does this; the payload is what the UI uses)");

  // An open shop follows the world. Nothing is pushed to the player: their client sees the
  // Trader's document change and asks the GM again, so this is the only place it can be proved.
  const opened = await player.inWorld("cross.mjs", "openShopAsPlayer", { traderId });
  if ( check("a player can open a shop window", opened.open, JSON.stringify(opened)) ) {
    check("which shows the open stock count", opened.badge === "2", `badge=${opened.badge}`);

    await gm.inWorld("cross.mjs", "setOpenStock", { traderId, qty: 6 });
    const restocked = await player.inWorld("cross.mjs", "readShopAsPlayer", { traderId });
    check("a GM restock appears in the player's open shop without a refresh",
      restocked.badge === "6", `badge=${restocked.badge}`);

    await gm.inWorld("cross.mjs", "setOpenStock", { traderId, qty: 0 });
    const sold = await player.inWorld("cross.mjs", "readShopAsPlayer", { traderId });
    check("and a line that sells out leaves the player's shelf",
      sold.open && sold.tile === false, JSON.stringify(sold));

    await player.inWorld("cross.mjs", "closeShopsAsPlayer");
  }

  await gm.inWorld("cross.mjs", "cleanupSharedTrader", { traderId });
  return failures;
}
