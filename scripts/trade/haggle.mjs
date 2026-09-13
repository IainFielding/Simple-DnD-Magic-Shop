import {
  HOOKS, MODULE_ID, SETTINGS, fireCancellableHook, fireHook, log, setting, t
} from "../config.mjs";
import {
  HAGGLE_SKILLS, haggleDc, haggleDelta, haggleEdge, isHaggleLocked
} from "../data/haggle.mjs";
import { serialised } from "../data/serial.mjs";
import { getAttitude, haggleRecordFor, nudgeAttitude, recordHaggleFailure } from "../data/trader.mjs";
import { resolveParties } from "./context.mjs";
import { QUERIES, defineQuery } from "./queries.mjs";

/**
 * Making a haggle check — on the GM's client, always.
 *
 * ## Why the GM rolls
 *
 * A check whose result moves attitude is a check whose result a player would like to choose. If a
 * player's client rolled and reported the total, a console command could report a 30. So the
 * player's shop sends only *which skill*, and the GM's client makes the roll with dnd5e's own
 * `rollSkill` against the character's real sheet, posts it to chat for everyone to see, and applies
 * the outcome. The lockout is written here too: a client that decided for itself whether to record
 * its own failure would simply never record one.
 *
 * Everything is re-derived from the documents — the DC from the Trader's Intelligence, the edge
 * from its attitude, the lock from its record — so the request carries nothing to trust.
 */

/**
 * Roll a haggle check and apply it.
 *
 * Queued with settlement: it writes attitude, and a trade reading attitude halfway through a haggle
 * would price against the wrong figure.
 * @param {object} params
 * @param {object} params.trader
 * @param {object} params.actor
 * @param {string} params.skill   A key from {@link HAGGLE_SKILLS}.
 * @returns {Promise<{skill: string, dc: number, total: number, success: boolean, from: number,
 *   to: number}>}
 */
export function haggle({ trader, actor, skill }) {
  return serialised(() => haggleNow({ trader, actor, skill }));
}

/** The body of {@link haggle}. Only ever run from inside the settlement queue. */
async function haggleNow({ trader, actor, skill }) {
  if ( !HAGGLE_SKILLS.includes(skill) ) throw new Error(t("error.haggleSkill"));
  if ( isHaggleLocked(haggleRecordFor(trader, actor), skill, game.time.worldTime) ) {
    throw new Error(t("error.haggleLocked", { skill: skillLabel(skill) }));
  }

  const attitude = getAttitude(trader, actor);
  const dc = haggleDc(trader.system?.abilities?.int?.value);
  const edge = haggleEdge(attitude);

  if ( !fireCancellableHook(HOOKS.preHaggle, { trader, actor, skill, dc, edge }) ) {
    throw new Error(t("error.haggleRefused"));
  }

  const rolls = await actor.rollSkill(
    { skill, target: dc, advantage: edge === "advantage", disadvantage: edge === "disadvantage" },
    // No dialog: the GM's client is making this roll on the player's behalf, and a configuration
    // window popping up on the GM's screen for someone else's check would be baffling.
    { configure: false },
    {
      // Public whatever the GM's own default is. The table should see the pitch land or fall flat.
      rollMode: "public",
      data: {
        flavor: t("haggle.flavor", { trader: trader.name }),
        flags: { [MODULE_ID]: { card: "haggle", traderId: trader.id } }
      }
    }
  );
  const roll = rolls?.[0];
  if ( !roll ) throw new Error(t("error.haggleNoRoll"));

  const total = Number(roll.total) || 0;
  const success = total >= dc;
  const delta = haggleDelta(success, {
    gain: setting(SETTINGS.haggleSuccess),
    loss: setting(SETTINGS.haggleFailure)
  });

  const moved = delta
    ? await nudgeAttitude(trader, actor, delta, { reason: "haggle" })
    : { from: attitude, to: attitude };
  if ( !success ) await recordHaggleFailure(trader, actor, skill);

  const outcome = { skill, dc, total, success, from: moved.from, to: moved.to };
  fireHook(HOOKS.haggled, { trader, actor, ...outcome });
  log(`haggle: ${actor.name} rolled ${total} vs DC ${dc} with ${skill} at "${trader.name}"`);
  return outcome;
}

/** A skill's localised name, for a refusal a player reads. */
export function skillLabel(skill) {
  const label = CONFIG.DND5E?.skills?.[skill]?.label;
  return label ? game.i18n.localize(label) : skill;
}

defineQuery(QUERIES.haggle, async (data, { user }) => {
  const { trader, actor } = resolveParties(data, user);
  return haggle({ trader, actor, skill: data?.skill });
}, { exclusive: true });
