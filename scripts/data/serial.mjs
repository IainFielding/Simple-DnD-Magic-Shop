/**
 * One-at-a-time execution for anything that reads a document and then writes it back.
 *
 * Settlement reads a Trader's stock and both purses, works out the result, and writes it. Two
 * settlements running at once can both read before either writes — and Foundry has no
 * transactions to stop them. That is not theoretical: two players racing for the last item on a
 * shelf both passed validation, both paid, one got the item and the other got nothing. Worse,
 * both wrote the Trader's purse from the same stale total, so one payment overwrote the other and
 * the loser's coin simply ceased to exist.
 *
 * Running them in sequence closes that completely. The second settlement starts only once the
 * first has finished writing, so it validates against the world as the first left it: the shelf
 * is empty, it is refused cleanly, and nobody is charged. Settlements take a handful of document
 * writes; queueing them costs nothing a table would notice.
 *
 * ## Why one queue for the whole world, not one per Trader
 *
 * A per-Trader queue would protect the Trader's purse but not the character's: the same
 * character settling at two Traders at once could still lose an update to their own purse. A
 * single queue has no such gap, and there is no throughput worth trading correctness for.
 *
 * ## What it does not cover
 *
 * This serialises work on **one client**. It is only a guarantee because every settlement runs
 * on the same one — the designated active GM — which `trade/queries.mjs#askGM` enforces. A second
 * GM settling on their own client would sit outside this queue, which is exactly why they do not.
 */

/** The tail of the queue. Always settled, so one failure cannot jam everything behind it. */
let tail = Promise.resolve();

/**
 * Run `task` after everything already queued, and return its result.
 *
 * A task that throws rejects its own promise — the caller still sees the refusal — but the queue
 * itself carries on, so a refused trade never blocks the next one.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function serialised(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}
