/**
 * Create the test worlds on disk.
 *
 * A Foundry world is just a directory under `Data/worlds` containing a `world.json` manifest;
 * Foundry builds the database on first activation and, finding no Gamemaster, creates a
 * passwordless user named "Gamemaster" — which is the account the harness logs in as. So
 * writing the manifest is the whole of world creation, with no setup-screen driving required.
 */

import fs from "node:fs";
import path from "node:path";
import { CORE_VERSION, DATA_DIR, SYSTEM, SYSTEM_VERSION, WORLDS } from "../config.mjs";

/** Absolute path of a world directory. */
export function worldDir(worldId) {
  return path.join(DATA_DIR, "worlds", worldId);
}

/** Whether the world already has a database, i.e. has been activated at least once. */
export function worldInitialised(worldId) {
  return fs.existsSync(path.join(worldDir(worldId), "data"));
}

/**
 * Write `world.json` for one of the configured worlds, creating the directory if needed.
 *
 * An existing manifest is left alone unless `force` is set, so re-provisioning never clobbers
 * a world's `lastPlayed` bookkeeping.
 * @param {string} worldId
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @returns {{created: boolean, dir: string}}
 */
export function ensureWorld(worldId, { force = false } = {}) {
  const spec = WORLDS[worldId];
  if ( !spec ) throw new Error(`Unknown world "${worldId}". Known: ${Object.keys(WORLDS).join(", ")}`);

  const dir = worldDir(worldId);
  const manifestPath = path.join(dir, "world.json");
  fs.mkdirSync(dir, { recursive: true });

  if ( fs.existsSync(manifestPath) && !force ) return { created: false, dir };

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    id: spec.id,
    title: spec.title,
    description: spec.description,
    system: SYSTEM,
    coreVersion: CORE_VERSION,
    systemVersion: SYSTEM_VERSION,
    // Left unset so Foundry stamps them itself on first launch.
    lastPlayed: "",
    playtime: 0
  }, null, 2)}\n`, "utf8");

  return { created: true, dir };
}

/**
 * Delete a world's database, keeping its manifest.
 *
 * The reset path for a run that has left a world in a confusing state. Manifest-only so the
 * next launch rebuilds from scratch without needing the world re-declared.
 * @param {string} worldId
 */
export function resetWorldData(worldId) {
  const data = path.join(worldDir(worldId), "data");
  if ( fs.existsSync(data) ) fs.rmSync(data, { recursive: true, force: true });
}
