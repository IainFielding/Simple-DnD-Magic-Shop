/**
 * The ledger: a Trader's memory of the deals it has struck.
 *
 * A receipt in chat is a moment; it scrolls away, and a GM trying to remember what the party sold
 * the blacksmith three sessions ago has nothing to search. The ledger keeps the same record on
 * the Trader itself, newest first, so the Trader Manager can show all of it and a player's shop
 * can show them their own.
 *
 * Pure throughout, like `attitude.mjs`: an entry is built from plain values, a ledger goes in and
 * a new one comes back, and nothing here reads a setting or writes a document. `data/trader.mjs`
 * owns the flag.
 *
 * ## What it is not
 *
 * Not a secrecy control. It lives in a flag on a world Actor, and Foundry sends every Actor to
 * every client — so a player filtering the ledger down to their own rows is a courtesy the GM's
 * client extends when it builds the shop, not a wall. See docs/PLAN.md §6.
 *
 * ## Why it is capped
 *
 * The flag replicates to every client on every write, and it is rewritten whole on every trade.
 * An uncapped list would make a busy Trader's every purchase a little slower than the last, for
 * ever. {@link LEDGER_LIMIT} keeps a campaign's worth of dealings and drops the oldest.
 */

/**
 * The most entries a Trader keeps. The oldest is dropped when a new one would exceed it.
 *
 * A hundred is several campaigns' worth of visits to one shop at a normal table, and at a few
 * hundred bytes an entry it keeps the whole flag well under what is noticeable to replicate.
 */
export const LEDGER_LIMIT = 100;

/**
 * @typedef {object} LedgerLine
 * @property {string} name
 * @property {number} qty
 * @property {number} lineCp   What the line came to, in copper.
 * @property {string} uuid     The item's compendium source where it has one, for a link.
 */

/**
 * @typedef {object} LedgerEntry
 * @property {string} id
 * @property {number} worldTime      When it happened, in game time (seconds).
 * @property {number} realTime       When it happened, at the table (ms since epoch).
 * @property {"trade"|"barter"} mode
 * @property {string} actorId        The character who traded.
 * @property {string} actorName      Their name at the time, so a deleted character still reads.
 * @property {string|null} payerId   A Group whose purse paid, or null for the character's own.
 * @property {string|null} payerName
 * @property {string} userName       Who pressed the button.
 * @property {LedgerLine[]} bought
 * @property {LedgerLine[]} sold
 * @property {number} costCp
 * @property {number} creditCp
 * @property {number} netCp          Positive when the purse paid out, negative when it took in.
 * @property {number} attitudeGained
 * @property {number} attitudeNow
 */

/* -------------------------------------------- */
/*  Building an entry                           */
/* -------------------------------------------- */

/** A whole, non-negative number, or 0. */
function count(value) {
  const n = Math.round(Number(value) || 0);
  return n > 0 ? n : 0;
}

/** A whole number that may be negative, or 0. */
function signed(value) {
  const n = Math.round(Number(value) || 0);
  return Number.isFinite(n) ? n : 0;
}

/** A string, or the fallback. */
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/**
 * Guard one line of goods.
 * @param {*} raw
 * @returns {LedgerLine|null}  Null for a line with no name or no quantity.
 */
export function sanitizeLedgerLine(raw) {
  if ( !raw || typeof raw !== "object" ) return null;
  const name = text(raw.name).trim();
  const qty = count(raw.qty);
  if ( !name || qty <= 0 ) return null;
  return { name, qty, lineCp: count(raw.lineCp), uuid: text(raw.uuid) };
}

/**
 * Build a ledger entry from a settled receipt.
 *
 * Takes the receipt's *figures* and the parties' *names*, never the documents, because an entry
 * outlives both: a character can be deleted, a Group renamed, and the ledger must still read as
 * it did on the day.
 *
 * @param {object} params
 * @param {string} params.id               A fresh id — injected so a test can pin it.
 * @param {object} params.receipt          From `trade/transaction.mjs#applyWrites`.
 * @param {number} params.worldTime
 * @param {number} params.realTime
 * @param {string} [params.userName]
 * @returns {LedgerEntry}
 */
export function makeEntry({ id, receipt, worldTime, realTime, userName = "" }) {
  const actor = receipt?.actor;
  const payer = receipt?.payer;
  // A Group paying is worth recording; the character's own purse paying is the default and
  // recording it would only mean every entry carrying its own name twice.
  const groupPaid = !!payer && payer.id !== actor?.id;
  return sanitizeEntry({
    id,
    worldTime,
    realTime,
    mode: receipt?.mode,
    actorId: actor?.id,
    actorName: actor?.name,
    payerId: groupPaid ? payer.id : null,
    payerName: groupPaid ? payer.name : null,
    userName,
    bought: receipt?.bought,
    sold: receipt?.sold,
    costCp: receipt?.costCp,
    creditCp: receipt?.creditCp,
    netCp: receipt?.netCp,
    attitudeGained: receipt?.attitudeGained,
    attitudeNow: receipt?.attitudeNow
  });
}

/**
 * Guard a stored entry field by field.
 *
 * Returns null for something that is not recognisably an entry at all — no id, or no character —
 * so a hand-edited flag loses its broken rows rather than rendering a table of blanks.
 * @param {*} raw
 * @returns {LedgerEntry|null}
 */
export function sanitizeEntry(raw) {
  if ( !raw || typeof raw !== "object" ) return null;
  const id = text(raw.id);
  const actorId = text(raw.actorId);
  if ( !id || !actorId ) return null;

  const lines = list => (Array.isArray(list) ? list : []).map(sanitizeLedgerLine).filter(Boolean);
  const payerId = text(raw.payerId) || null;
  return {
    id,
    worldTime: signed(raw.worldTime),
    realTime: count(raw.realTime),
    mode: raw.mode === "barter" ? "barter" : "trade",
    actorId,
    actorName: text(raw.actorName),
    payerId,
    payerName: payerId ? text(raw.payerName) : null,
    userName: text(raw.userName),
    bought: lines(raw.bought),
    sold: lines(raw.sold),
    costCp: count(raw.costCp),
    creditCp: count(raw.creditCp),
    netCp: signed(raw.netCp),
    attitudeGained: count(raw.attitudeGained),
    attitudeNow: Math.min(100, count(raw.attitudeNow))
  };
}

/* -------------------------------------------- */
/*  The ledger                                  */
/* -------------------------------------------- */

/**
 * Guard a whole stored ledger: broken rows dropped, newest first, capped.
 *
 * Sorted on read rather than trusted, because the order *is* the reading — a ledger whose newest
 * trade sat halfway down would be worse than useless. World time decides first; real time breaks
 * a tie, since a whole shopping trip normally happens without the game clock moving.
 * @param {*} raw
 * @param {number} [limit]
 * @returns {LedgerEntry[]}
 */
export function sanitizeLedger(raw, limit = LEDGER_LIMIT) {
  const entries = (Array.isArray(raw) ? raw : []).map(sanitizeEntry).filter(Boolean);
  entries.sort((a, b) => (b.worldTime - a.worldTime) || (b.realTime - a.realTime));
  return entries.slice(0, Math.max(0, limit));
}

/**
 * Add an entry to the front of a ledger, dropping the oldest past the limit.
 * @param {*} ledger
 * @param {LedgerEntry} entry
 * @param {number} [limit]
 * @returns {LedgerEntry[]}  A new array; the input is not modified.
 */
export function appendEntry(ledger, entry, limit = LEDGER_LIMIT) {
  const clean = sanitizeEntry(entry);
  const existing = sanitizeLedger(ledger, Infinity).filter(e => e.id !== clean?.id);
  return sanitizeLedger(clean ? [clean, ...existing] : existing, limit);
}

/**
 * One character's dealings, newest first.
 * @param {*} ledger
 * @param {string} actorId
 * @param {number} [limit]
 * @returns {LedgerEntry[]}
 */
export function entriesFor(ledger, actorId, limit = LEDGER_LIMIT) {
  if ( !actorId ) return [];
  return sanitizeLedger(ledger, Infinity).filter(e => e.actorId === actorId).slice(0, limit);
}

/**
 * The characters who appear in a ledger, for the manager's filter — by id, with the most recent
 * name each traded under.
 * @param {*} ledger
 * @returns {{id: string, name: string, count: number}[]}  Sorted by name.
 */
export function ledgerCharacters(ledger) {
  const seen = new Map();
  // Newest first, so the first name met for an id is the latest one.
  for ( const entry of sanitizeLedger(ledger, Infinity) ) {
    const known = seen.get(entry.actorId);
    if ( known ) known.count++;
    else seen.set(entry.actorId, { id: entry.actorId, name: entry.actorName, count: 1 });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a set of entries adds up to, from the Trader's side of the counter.
 *
 * `takenCp` and `paidCp` are the coin that actually changed hands — not the goods' value — so a
 * barter contributes only the coin that was added to it, which is exactly what it moved.
 * @param {LedgerEntry[]} entries
 * @returns {{trades: number, takenCp: number, paidCp: number, itemsSold: number, itemsBought: number}}
 */
export function ledgerTotals(entries) {
  const totals = { trades: 0, takenCp: 0, paidCp: 0, itemsSold: 0, itemsBought: 0 };
  for ( const entry of entries ?? [] ) {
    totals.trades++;
    if ( entry.netCp > 0 ) totals.takenCp += entry.netCp;
    else totals.paidCp += -entry.netCp;
    // "Sold" and "bought" from the Trader's side: what the character bought, the Trader sold.
    totals.itemsSold += entry.bought.reduce((sum, line) => sum + line.qty, 0);
    totals.itemsBought += entry.sold.reduce((sum, line) => sum + line.qty, 0);
  }
  return totals;
}
