/**
 * An undo journal for one settlement.
 *
 * Foundry has no transactions. A trade is a handful of separate document writes — coin, the
 * Trader's shelves, the character's pack — and any one of them can fail after the others have
 * landed: another module's `preCreateItem` refusing the granted item, a dropped connection, a
 * validation error on a document nobody expected to be malformed. Before this, the coin had simply
 * moved and nothing brought it back.
 *
 * So every write records how to reverse itself, as it succeeds, and a failure replays those in
 * reverse. Each reversal is written as a **delta against whatever is there now**, never as a
 * snapshot to restore: the character owns their own sheet and may have spent coin on another
 * client in the meantime, and writing an old purse back would erase that spending.
 *
 * Pure: it holds closures and runs them. What a closure does is the caller's business, which is
 * what lets the tests drive it with plain functions.
 */
export class Journal {

  /** `{label, undo}` in the order the writes happened. */
  #entries = [];

  /**
   * Record how to reverse a write that has just succeeded.
   * @param {string} label             For the log, when a reversal itself fails.
   * @param {() => Promise<*>} undo
   */
  record(label, undo) {
    if ( typeof undo === "function" ) this.#entries.push({ label, undo });
  }

  /** How many writes are on record. */
  get size() {
    return this.#entries.length;
  }

  /**
   * Reverse every recorded write, newest first.
   *
   * Carries on past a reversal that fails, because the others are still worth doing — leaving a
   * character's coin taken because the Trader's shelf could not be restored would be the worst of
   * both. What could not be undone is reported, so the GM can be told exactly what to fix by hand.
   * @returns {Promise<{undone: string[], failed: {label: string, error: Error}[]}>}
   */
  async rollback() {
    const undone = [];
    const failed = [];
    for ( const { label, undo } of [...this.#entries].reverse() ) {
      try {
        await undo();
        undone.push(label);
      } catch ( error ) {
        failed.push({ label, error });
      }
    }
    this.#entries = [];
    return { undone, failed };
  }
}

/**
 * The per-denomination change between two purses: `after − before` for every coin either holds.
 * @param {Record<string, number>} before
 * @param {Record<string, number>} after
 * @returns {Record<string, number>}  Only denominations that changed.
 */
export function currencyDelta(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for ( const key of keys ) {
    const diff = (Math.floor(Number(after?.[key]) || 0)) - (Math.floor(Number(before?.[key]) || 0));
    if ( diff ) out[key] = diff;
  }
  return out;
}

/**
 * A purse update that takes a delta back out of whatever the purse holds now.
 *
 * Clamped at zero per denomination. A character who has since spent the very coins being returned
 * to the Trader cannot go negative; the shortfall is simply not recovered, which is the right way
 * round for a rollback to be imperfect.
 * @param {Record<string, number>} current  The purse as it is now.
 * @param {Record<string, number>} delta    The change being reversed.
 * @returns {Record<string, number>}  An update for `system.currency.<denomination>` paths.
 */
export function reverseCurrency(current, delta) {
  const update = {};
  for ( const [key, diff] of Object.entries(delta ?? {}) ) {
    const now = Math.floor(Number(current?.[key]) || 0);
    update[`system.currency.${key}`] = Math.max(0, now - diff);
  }
  return update;
}
