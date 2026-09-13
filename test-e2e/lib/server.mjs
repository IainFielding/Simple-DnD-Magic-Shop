/**
 * Spawn and stop the harness's own Foundry server.
 *
 * The instance runs on {@link PORT} (not Foundry's default) against the *same* data path as the
 * normal install, so it sees the real systems, modules and compendia. Foundry hosts one active
 * world at a time, so a run covering both test worlds launches the server twice rather than
 * trying to switch worlds in place.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { BASE_URL, DATA_PATH, FOUNDRY_ROOT, PORT, SERVER_TIMEOUT_MS } from "../config.mjs";

/** Grace period between the port opening and the first client connection. See {@link launch}. */
const SETTLE_MS = 3000;

/** Whether something is already listening on our port — usually a crashed previous run. */
export async function portInUse() {
  try {
    await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch Foundry with a world already active.
 * @param {string} worldId
 * @param {object} [options]
 * @param {boolean} [options.verbose]  Mirror Foundry's stdout to ours.
 * @returns {Promise<{stop: () => Promise<void>, log: string[], child: object}>}
 */
export async function startFoundry(worldId, { verbose = false } = {}) {
  // Foundry locks its *data directory*, so only one instance may use it at a time — including
  // the user's own desktop Foundry. A hard-killed instance leaves a lock that goes stale after
  // ~10s, so retrying clears the common case (a crashed run) while a genuinely running Foundry
  // still fails, with an explanation rather than a lock-file error.
  for ( let attempt = 1; ; attempt++ ) {
    try {
      return await launch(worldId, { verbose });
    } catch ( err ) {
      const locked = /already locked/i.test(err.message);
      if ( !locked || (attempt >= 3) ) {
        if ( locked ) {
          throw new Error("Foundry's data directory is locked by another process. Close any "
            + "running Foundry (the desktop app, or a previous harness run) and try again.");
        }
        throw err;
      }
      await sleep(8000);
    }
  }
}

/** One launch attempt. See {@link startFoundry} for the lock retry that wraps this. */
async function launch(worldId, { verbose = false } = {}) {
  if ( await portInUse() ) {
    throw new Error(`Port ${PORT} is already in use. A previous harness run may not have shut `
      + "down — kill the stray node process and retry.");
  }

  const args = [
    `${FOUNDRY_ROOT}/main.mjs`,
    `--dataPath=${DATA_PATH}`,
    `--port=${PORT}`,
    `--world=${worldId}`,
    "--noupdate",
    // Foundry opens the port *before* it finishes discovering its own IP addresses: the listen
    // callback awaits a round trip to foundryvtt.com. Until that resolves `express.addresses` is
    // null, and a client joining in that window makes the world payload throw while building
    // invitation links. The client then receives a payload with no `release` and dies in
    // `new Game()` with a ReleaseData validation error — a thoroughly misleading symptom of a
    // startup race. This skips the lookup; SETTLE_MS below closes the remaining sliver.
    "--noipdiscovery"
  ];

  const child = spawn(process.execPath, args, {
    cwd: FOUNDRY_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const log = [];
  const capture = chunk => {
    const text = chunk.toString();
    log.push(text);
    if ( verbose ) process.stdout.write(text);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  // Poll until the HTTP server answers. Foundry's own "listening" log line is localised and has
  // moved between releases, so a real request is the more durable readiness signal.
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while ( Date.now() < deadline ) {
    if ( exited ) {
      throw new Error(`Foundry exited before becoming ready (code ${exited.code}).\n${log.join("")}`);
    }
    if ( await portInUse() ) {
      await sleep(SETTLE_MS);
      return { stop: () => stopFoundry(child), log, child };
    }
    await sleep(500);
  }
  await stopFoundry(child);
  throw new Error(`Foundry did not start within ${SERVER_TIMEOUT_MS}ms.\n${log.join("")}`);
}

/**
 * Terminate the server process. Windows has no real SIGTERM, so this is a hard kill.
 * @param {import("node:child_process").ChildProcess} child
 */
export async function stopFoundry(child) {
  if ( !child || child.exitCode !== null ) return;
  const done = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await Promise.race([done, sleep(10_000)]);
  if ( child.exitCode === null ) child.kill("SIGKILL");
}
