/**
 * One-time (idempotent) setup of the test worlds.
 *
 *   node provision.mjs                  # every world
 *   node provision.mjs magicshop        # just one
 *   node provision.mjs --reset          # delete the databases first and rebuild
 *
 * For each world this writes the manifest, activates the world (Foundry creates the database
 * and a passwordless "Gamemaster"), enables exactly the configured module set, reloads, verifies
 * every module actually came up active, and creates the player users and their characters.
 */

import { MODULE_ID, PLAYERS, WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld, resetWorldData, worldInitialised } from "./lib/worlds.mjs";

const argv = process.argv.slice(2);
const reset = argv.includes("--reset");
const force = argv.includes("--force");
const targets = argv.filter(a => !a.startsWith("--"));
const worlds = targets.length ? targets : Object.keys(WORLDS);

for ( const id of worlds ) {
  if ( !WORLDS[id] ) {
    console.error(`Unknown world "${id}". Known: ${Object.keys(WORLDS).join(", ")}`);
    process.exit(1);
  }
}

for ( const worldId of worlds ) await provision(worldId);

/* -------------------------------------------- */

async function provision(worldId) {
  const spec = WORLDS[worldId];
  console.log(`\n=== Provisioning "${spec.title}" (${worldId}) ===`);

  if ( reset ) {
    resetWorldData(worldId);
    console.log("  database reset");
  }
  const { created } = ensureWorld(worldId, { force });
  console.log(`  manifest ${created ? "created" : "already present"}; database `
    + `${worldInitialised(worldId) ? "exists" : "will be created on first launch"}`);

  const server = await startFoundry(worldId);
  let session;
  try {
    session = await Session.open();
    console.log("  joined as Gamemaster");

    const result = await enableModules(session, spec.modules);
    if ( result.changed ) {
      console.log(`  module configuration written (${result.enabled.length} enabled), reloading…`);
      await session.page.reload({ waitUntil: "domcontentloaded" });
      await session.waitForReady();
    } else {
      console.log("  module configuration already correct");
    }

    const status = await moduleStatus(session, spec.modules);
    for ( const m of status ) console.log(`    ${m.active ? "on " : "OFF"} ${m.id}`);
    const missing = status.filter(m => !m.active);
    if ( missing.length ) {
      throw new Error(`These modules did not come up active: ${missing.map(m => m.id).join(", ")}`);
    }

    // The harness leans on the module's own debug log: a refused query or a swallowed resolver
    // error explains itself through those lines. Turned on after the reload, because the setting
    // only exists once the module has registered it.
    await session.eval(async id => {
      try { await game.settings.set(id, "debugLogging", true); } catch { /* not active */ }
    }, MODULE_ID);
    console.log("  debug logging enabled");

    const users = await session.inWorld("provision.mjs", "ensureUsers", PLAYERS);
    for ( const user of users ) {
      console.log(`    user "${user.name}" -> character "${user.character}"`);
    }

    await session.close({ returnToSetup: true });
    session = null;
    console.log("  done");
  } catch ( err ) {
    if ( session ) {
      console.error(`\n--- console tail ---\n${session.tail(40)}\n`);
      await session.close();
    }
    throw err;
  } finally {
    await server.stop();
  }
}

/* -------------------------------------------- */

/**
 * Write the world's module configuration.
 *
 * Set wholesale rather than toggled, so a world left in a strange state by a previous run comes
 * back to exactly the configured set — including switching *off* anything not in it.
 */
async function enableModules(session, modules) {
  return session.eval(async wanted => {
    const settings = game.settings.get("core", "moduleConfiguration") ?? {};
    const next = { ...settings };
    let changed = false;
    for ( const id of game.modules.keys() ) {
      const shouldBeOn = wanted.includes(id);
      if ( !!next[id] === shouldBeOn ) continue;
      next[id] = shouldBeOn;
      changed = true;
    }
    if ( changed ) await game.settings.set("core", "moduleConfiguration", next);
    return { changed, enabled: wanted };
  }, modules);
}

/** Whether each wanted module is actually active. */
async function moduleStatus(session, modules) {
  return session.eval(wanted => wanted.map(id => ({
    id,
    active: game.modules.get(id)?.active === true
  })), modules);
}
