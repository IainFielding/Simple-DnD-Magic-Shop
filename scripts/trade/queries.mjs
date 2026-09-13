import { MODULE_ID, log, t } from "../config.mjs";
import { claim, claimKey, staySilent } from "./claim.mjs";

/**
 * The client-to-GM boundary.
 *
 * Players get **no ownership** of Trader actors, so a player's browser cannot read a Trader's
 * stock and must never be trusted to compute a price it then gets to pay. Every shop therefore
 * talks to a GM client:
 *
 *  1. the player asks for a **context payload** — visible stock only, already priced;
 *  2. the player sends back **intent** (item ids and quantities, never prices);
 *  3. the GM client re-derives every price from scratch and settles.
 *
 * Foundry's user queries are the transport: a typed request to one specific client with a
 * promised reply. The receiving handler is handed the **requesting `User` document** by the
 * framework, which is the security anchor for the whole design — the GM side never has to trust
 * a user id inside the payload, because it is told who actually asked.
 *
 * ## Consequences, both accepted
 *
 * **An active GM is required.** With nobody to ask, the chat card and the API both report the
 * Trader as away. The alternative was granting players observer rights on Trader actors, which
 * would let them read hidden stock and the Trader's purse straight off the actor sheet, and let
 * a modified client invent prices. See docs/PLAN.md §6.
 *
 * **One GM settles, even when several are online.** `game.users.activeGM` designates exactly
 * one, deterministically, so two GMs cannot both process the same purchase and hand out the
 * item twice.
 *
 * **One window settles, even when that GM has two open.** `activeGM` names a user, not a tab, and
 * Foundry delivers a query to every tab the user has. Queries that write are declared
 * `exclusive`, and each tab claims the request before acting on it — see `trade/claim.mjs`.
 */

/** Every query this module registers, as `alias -> the prefixed name Foundry needs`. */
export const QUERIES = Object.freeze({
  /** `{traderId, actorId}` -> a shop context payload. */
  context: `${MODULE_ID}.shopContext`,
  /** `{traderId, actorId, mode, buy, sell, goldCp}` -> a receipt. */
  trade: `${MODULE_ID}.trade`,
  /** `{traderId, actorId, skill}` -> the outcome of a haggle check. */
  haggle: `${MODULE_ID}.haggle`,
  /**
   * `{traderId}` -> whether this client opened the shop. The one query that runs on a **player's**
   * client: the GM asks each player to open a shop for their own character.
   */
  showShop: `${MODULE_ID}.showShop`
});

/** How long a client waits for a GM before giving up, in milliseconds. */
const TIMEOUT = 20_000;

/**
 * Handlers, registered by `registerQueries` at `init`.
 *
 * Held in a mutable map rather than wired directly into `CONFIG.queries` so that `trade/`
 * modules can register themselves as they are loaded, and so a milestone that has not landed
 * yet simply has no entry rather than a stub that pretends to work.
 * @type {Map<string, Function>}
 */
const handlers = new Map();

/** The queries that write, and so must be claimed by exactly one tab. */
const exclusive = new Set();

/**
 * Declare the handler for one query. Called at module scope by the file that implements it.
 * @param {string} name      A value from {@link QUERIES}.
 * @param {(data: object, context: {user: object}) => Promise<*>} handler
 * @param {object} [options]
 * @param {boolean} [options.exclusive]  The handler writes: only one of the receiving user's tabs
 *                                       may run it. Reads leave this off, since answering twice is
 *                                       harmless and claiming costs a moment.
 */
export function defineQuery(name, handler, { exclusive: writes = false } = {}) {
  handlers.set(name, handler);
  if ( writes ) exclusive.add(name);
  else exclusive.delete(name);
}

/**
 * Install every declared handler into `CONFIG.queries`.
 *
 * Wrapped rather than assigned raw, for two reasons. A handler that throws must come back to
 * the player as a *readable* refusal rather than a stack trace — Foundry passes `e.message`
 * across the wire and nothing else. And every refusal should be logged on the GM's client,
 * because the player's console will only ever show the sanitised message.
 */
export function registerQueries() {
  CONFIG.queries ??= {};
  for ( const [name, handler] of handlers ) {
    CONFIG.queries[name] = async (data, context) => {
      // Claimed before the handler runs, so the losing tab does no work at all — not even the
      // validation, whose refusal would otherwise race the winner's answer back to the player.
      if ( exclusive.has(name) && !(await claim(claimKey(data, context?.user, name))) ) {
        return staySilent(context?.timeout);
      }
      try {
        return await handler(data, context);
      } catch ( err ) {
        log(`query "${name}" refused for ${context?.user?.name}:`, err);
        // Re-thrown so the caller's promise rejects; the message is the whole payload.
        throw err;
      }
    };
  }
  log(`registered ${handlers.size} queries`);
}

/* -------------------------------------------- */
/*  The client side                             */
/* -------------------------------------------- */

/**
 * Whether there is a GM available to answer.
 *
 * A GM's *own* client answers itself, so a solo GM testing a shop is never "away".
 * @returns {boolean}
 */
export function gmAvailable() {
  return game.user.isGM || !!game.users.activeGM;
}

/**
 * Ask the GM something, or run it locally when we *are* the GM who answers.
 *
 * The local shortcut is not an optimisation, it is correctness: a user cannot query themselves.
 * Routing the answering GM's own request through the handler directly means the shop behaves
 * identically whoever opens it, and the authoritative path is exercised in single-player testing
 * rather than skipped.
 *
 * **Only the active GM runs it locally.** Any other GM is routed to the active GM like a player
 * would be. Settlement is serialised on one client (`data/serial.mjs`), so a second GM settling on
 * their own would run beside that queue rather than in it, and two purchases of the last item
 * could both succeed again.
 *
 * @param {string} name        A value from {@link QUERIES}.
 * @param {object} data        Must be JSON-serialisable.
 * @returns {Promise<*>}       The handler's value.
 * @throws {Error}             With a player-readable message when no GM is available, the GM
 *                             refuses, or the request times out.
 */
export async function askGM(name, data) {
  // A fresh id per request, which is what every tab of the GM claims it under. Added here, once,
  // so no caller can forget it.
  data = { ...data, requestId: foundry.utils.randomID() };
  const gm = game.users.activeGM;
  if ( game.user.isGM && (!gm || gm.id === game.user.id) ) {
    const handler = handlers.get(name);
    if ( !handler ) throw new Error(`No handler registered for "${name}"`);
    return handler(data, { user: game.user });
  }

  if ( !gm ) throw new Error(t("error.noGM"));

  try {
    return await game.users.get(gm.id).query(name, data, { timeout: TIMEOUT });
  } catch ( err ) {
    // A timeout and a refusal arrive the same way, so the message is all there is to go on.
    log(`query "${name}" failed:`, err);
    throw new Error(err.message || t("error.queryFailed"));
  }
}
