/**
 * Diagnostics: bring a world up, join it, and dump the client's whole console.
 *
 *   node probe.mjs                     # the main world, as the Gamemaster
 *   node probe.mjs --world=magicshop-bare
 *   node probe.mjs --user="Player One"
 *   node probe.mjs --no-module         # with the module under test switched off
 *
 * `--no-module` is the one that settles arguments. Several console lines in a headless,
 * canvas-less Foundry come from Foundry or the system rather than from us, and "does this still
 * happen with our module absent" is the only question that decides whose they are.
 */

import { MODULE_ID, WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld } from "./lib/worlds.mjs";

const argv = process.argv.slice(2);
const flag = name => argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1];
const has = name => argv.includes(`--${name}`);

const worldId = flag("world") ?? "magicshop";
const user = flag("user");
const withoutModule = has("no-module");

if ( !WORLDS[worldId] ) {
  console.error(`Unknown world "${worldId}".`);
  process.exit(1);
}
ensureWorld(worldId);

const server = await startFoundry(worldId, { verbose: has("verbose") });
let session;
try {
  session = await Session.open(user ? { user } : {});
  console.log(`joined "${worldId}" as ${session.userName}\n`);

  if ( withoutModule ) {
    await session.eval(async id => {
      const config = { ...(game.settings.get("core", "moduleConfiguration") ?? {}) };
      config[id] = false;
      await game.settings.set("core", "moduleConfiguration", config);
    }, MODULE_ID);
    console.log("module switched off; reloading…\n");
    session.consoleLog.length = 0;
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await session.waitForReady();
  }

  const active = await session.eval(() => ({
    module: game.modules.get("sogrom-simple-dnd5e-magic-shop")?.active ?? false,
    system: `${game.system.id} ${game.system.version}`,
    core: game.version,
    users: game.users.filter(u => u.active).map(u => u.name)
  }));
  console.log(`core ${active.core} · ${active.system} · module active: ${active.module}`);
  console.log(`active users: ${active.users.join(", ")}\n`);

  if ( has("suites") ) {
    // Run the in-world suites so the console shows what *they* provoke, in order. A plain join
    // is quiet; anything noisy comes from something a test does, and this is how to find out
    // which test.
    session.consoleLog.length = 0;
    await session.inWorld("harness.mjs", "all");
    console.log("--- console during harness.mjs ---");
    for ( const line of session.consoleLog ) console.log(line);

    session.consoleLog.length = 0;
    await session.inWorld("trade.mjs", "all");
    console.log("\n--- console during trade.mjs ---");
    for ( const line of session.consoleLog ) console.log(line);
  } else {
    console.log("--- full console ---");
    for ( const line of session.consoleLog ) console.log(line);
  }

  if ( withoutModule ) {
    // Put it back, or every later run would silently test nothing.
    await session.eval(async id => {
      const config = { ...(game.settings.get("core", "moduleConfiguration") ?? {}) };
      config[id] = true;
      await game.settings.set("core", "moduleConfiguration", config);
    }, MODULE_ID);
    console.log("\nmodule switched back on");
  }
} finally {
  if ( session ) await session.close({ returnToSetup: true }).catch(() => {});
  await server.stop();
}
