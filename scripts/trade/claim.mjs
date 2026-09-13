import { MODULE_ID, log } from "../config.mjs";

/**
 * One window settles, even when the GM has the game open twice.
 *
 * ## The problem
 *
 * `game.users.activeGM` names a **user**, not a connection. A GM with two tabs open — a second
 * monitor, a forgotten window, a laptop beside the desktop — is the active GM in both, and
 * Foundry's server delivers a user query to **every socket** that user has (`activity.mjs`:
 * `sockets.forEach(socket => socket.emit("userQuery", …))`). Both tabs run the trade handler. The
 * player gets whichever answer arrives first, but both tabs have written: the item is handed over
 * twice, and both read the purse before either wrote it, so it is paid for once. The settlement
 * queue (`data/serial.mjs`) cannot help — it orders work inside one tab, and these are two.
 *
 * ## The fix: a claim per request
 *
 * Before doing anything that writes, a tab announces "I will take request X" over the module
 * socket, waits a moment for any sibling to say the same, and proceeds only if its own random id
 * is the lowest of the claimants. The ids are fixed for the life of a tab, so the same tab wins
 * every contested request and settlements stay in one queue.
 *
 * The losing tab never answers. Foundry resolves a query with the **first** reply it receives and
 * ignores any after it, so silence is exactly right — see {@link staySilent}.
 *
 * A heartbeat electing a permanent leader was the obvious alternative and was rejected: it has to
 * decide when a silent tab is dead, and in that window either nobody settles or two do. A claim per
 * request has no such window; whoever is present at that moment answers.
 *
 * ## Only when it can matter
 *
 * Waiting costs {@link CLAIM_WAIT} milliseconds per trade, which nobody notices, but it would be
 * pointless for the overwhelmingly common GM with one tab. So tabs greet each other when they load
 * ({@link greet}); a tab that has never heard from a sibling claims instantly. A sibling that loads
 * later greets on arrival and is answered, so neither can miss the other.
 *
 * ## What it does not defend against
 *
 * Module socket messages carry no sender the client can verify. A player sending forged claims
 * could make the GM's tabs wait, or — by guessing a request key, which is a random id — stall one
 * trade until it times out. Neither moves anything of value; the authority checks all live in the
 * handlers themselves, against the user Foundry's query framework attaches.
 */

/** How long a tab waits for sibling claims before deciding, in milliseconds. */
export const CLAIM_WAIT = 250;

/** How long a stale claim record is kept, so the book cannot grow for ever. */
const CLAIM_TTL = 10_000;

/** The module's socket channel. Requires `"socket": true` in module.json. */
export const SOCKET = `module.${MODULE_ID}`;

/** This tab. Random, and fixed for as long as the tab is open. */
export const CLIENT_ID = globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2);

/* -------------------------------------------- */
/*  The claim book (pure)                       */
/* -------------------------------------------- */

/**
 * Who has claimed which request. Plain data with a clock injected, so the election is testable
 * without a socket.
 */
export class ClaimBook {

  /** `key -> {clients: Set<string>, at: number}`. */
  #claims = new Map();

  /**
   * Record a claim.
   * @param {string} key       The request.
   * @param {string} clientId  The tab claiming it.
   * @param {number} [now]
   */
  record(key, clientId, now = Date.now()) {
    if ( !key || !clientId ) return;
    this.prune(now);
    const entry = this.#claims.get(key) ?? { clients: new Set(), at: now };
    entry.clients.add(clientId);
    this.#claims.set(key, entry);
  }

  /**
   * Whether a tab won a request: its id is the lowest of everyone who claimed it.
   *
   * A tab that somehow never recorded its own claim does not win, which fails toward silence — a
   * trade that times out is recoverable, one settled twice is not.
   * @param {string} key
   * @param {string} clientId
   * @returns {boolean}
   */
  won(key, clientId) {
    const clients = this.#claims.get(key)?.clients;
    if ( !clients?.has(clientId) ) return false;
    return winner(clients) === clientId;
  }

  /** Forget claims older than the time-to-live. */
  prune(now = Date.now()) {
    for ( const [key, entry] of this.#claims ) {
      if ( now - entry.at > CLAIM_TTL ) this.#claims.delete(key);
    }
  }

  /** How many requests are on record, for the tests. */
  get size() {
    return this.#claims.size;
  }
}

/**
 * The winning client among a set of claimants: the lowest id, compared as plain strings so every
 * tab reaches the same answer.
 * @param {Iterable<string>} clients
 * @returns {string|null}
 */
export function winner(clients) {
  let best = null;
  for ( const id of clients ?? [] ) {
    if ( typeof id !== "string" || !id ) continue;
    if ( best === null || id < best ) best = id;
  }
  return best;
}

/**
 * The key a request is claimed under.
 *
 * Every tab receives the same payload, so a request id inside it is the natural key; the shop and
 * the API add one to every write. Without one — an older client mid-update — the requesting user
 * and the payload itself stand in, which every tab can also compute identically.
 * @param {object} data      The query payload.
 * @param {object} [user]    The requesting user, from the query framework.
 * @param {string} name      The query name.
 * @returns {string}
 */
export function claimKey(data, user, name) {
  const id = typeof data?.requestId === "string" && data.requestId ? data.requestId : "";
  if ( id ) return `${name}:${id}`;
  let body = "";
  try {
    body = JSON.stringify(data ?? null);
  } catch {
    body = String(data);
  }
  return `${name}:${user?.id ?? "?"}:${body}`;
}

/* -------------------------------------------- */
/*  The live half                               */
/* -------------------------------------------- */

const book = new ClaimBook();

/** Sibling tabs of the same user this tab has heard from. */
const siblings = new Set();

/**
 * Listen on the module socket. Called once, at `init`.
 *
 * Messages from another user are ignored outright: only a tab signed in as the same user can be a
 * sibling that might also receive our queries.
 */
export function registerClaims() {
  game.socket?.on(SOCKET, message => {
    if ( !message || message.userId !== game.user?.id || message.clientId === CLIENT_ID ) return;
    switch ( message.kind ) {
      case "hello":
        siblings.add(message.clientId);
        emit({ kind: "here" });
        break;
      case "here":
        siblings.add(message.clientId);
        break;
      case "claim":
        siblings.add(message.clientId);
        book.record(message.key, message.clientId);
        break;
    }
  });
}

/**
 * Tell any sibling tab this one exists. Called at `ready`, and only for a GM — a player's second
 * tab settles nothing, so there is nothing to coordinate.
 */
export function greet() {
  if ( !game.user?.isGM ) return;
  emit({ kind: "hello" });
}

/**
 * Claim a request, and report whether this tab should act on it.
 * @param {string} key
 * @param {object} [options]
 * @param {number} [options.wait]  Override {@link CLAIM_WAIT}, for the harness.
 * @returns {Promise<boolean>}
 */
export async function claim(key, { wait = CLAIM_WAIT } = {}) {
  // Alone: nobody else can have received it.
  if ( !siblings.size ) return true;
  book.record(key, CLIENT_ID);
  emit({ kind: "claim", key });
  await new Promise(resolve => setTimeout(resolve, wait));
  const won = book.won(key, CLIENT_ID);
  if ( !won ) log(`another window claimed "${key}"; staying silent`);
  return won;
}

/**
 * A promise for the tab that lost a claim: it settles only once the request is long over.
 *
 * It must not settle early. Foundry takes the first reply, so a loser that answered before the
 * winner — even with an error — would be the answer the player saw. Waiting past the query's own
 * timeout guarantees the winner's reply, or the timeout, has already been taken.
 * @param {number} [timeout]  The query's timeout, in milliseconds.
 * @returns {Promise<never>}
 */
export function staySilent(timeout = 20_000) {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("handled by another window")), (Number(timeout) || 20_000) + 5_000);
  });
}

/** Whether this tab has heard from a sibling. For the harness and the debug log. */
export function hasSiblings() {
  return siblings.size > 0;
}

function emit(payload) {
  game.socket?.emit(SOCKET, { ...payload, userId: game.user?.id, clientId: CLIENT_ID });
}
