/**
 * Paying from the party's purse: which dnd5e Group actors a character may spend from.
 *
 * A Group is dnd5e's own "party" actor. It has a currency of its own and a list of members, and
 * tables use it as the shared fund — the chest the party's gold goes into after a dungeon. Letting
 * a member pay a Trader straight out of it saves the familiar "everyone give Bob forty gold"
 * shuffle before the fighter can buy plate.
 *
 * ## The rule
 *
 * A character may pay from a Group when **both** hold:
 *
 *  - **the character is one of its members** — a Group that has nothing to do with them is not
 *    their party's purse, whoever owns it; and
 *  - **the requesting user owns the Group**, or is a GM. Ownership is Foundry's own statement of
 *    who may change an actor, so the GM already has the control they need: give the party Owner
 *    on the Group to share the fund, or keep it and hold the purse strings.
 *
 * Membership alone was the alternative, and was declined: it would let any member empty the fund
 * without the GM ever having granted anybody the right to touch it.
 *
 * Pure and Foundry-free. Actors and users are read through the handful of properties dnd5e and
 * Foundry give them, so a test can pass plain objects.
 */

/** The actor type dnd5e gives its party actor. */
export const GROUP_TYPE = "group";

/**
 * The ids of a Group's members.
 *
 * dnd5e 6 prepares `system.members` as an array of `{actor}` entries, where `actor` is the member
 * document once the world has loaded and a bare id in source data. It also hangs an `ids` Set off
 * the array during data preparation. All three shapes are read, so a member is recognised whether
 * the Group was prepared, is mid-migration, or is a test fixture.
 * @param {object} group
 * @returns {Set<string>}
 */
export function memberIds(group) {
  const members = group?.system?.members;
  if ( members?.ids instanceof Set ) return new Set(members.ids);
  const ids = new Set();
  for ( const member of Array.isArray(members) ? members : [] ) {
    const id = typeof member?.actor === "string" ? member.actor : member?.actor?.id;
    if ( id ) ids.add(id);
  }
  return ids;
}

/**
 * Whether an actor is a member of a Group.
 * @param {object} group
 * @param {string} actorId
 * @returns {boolean}
 */
export function isMember(group, actorId) {
  return !!actorId && memberIds(group).has(actorId);
}

/**
 * Whether a user may pay for a character's purchase out of a Group's purse.
 *
 * @param {object} params
 * @param {object} params.group   The Group actor.
 * @param {object} params.actor   The character doing the shopping.
 * @param {object} params.user    The requesting user — on the GM's side, the one Foundry's query
 *                                framework attached, never one named in the payload.
 * @returns {boolean}
 */
export function canPayFrom({ group, actor, user } = {}) {
  if ( !group || group.type !== GROUP_TYPE ) return false;
  if ( !isMember(group, actor?.id) ) return false;
  if ( user?.isGM ) return true;
  return group.testUserPermission?.(user, "OWNER") === true;
}

/**
 * Every Group a user may pay from for this character, sorted by name.
 * @param {Iterable<object>} actors   Usually `game.actors`.
 * @param {object} actor
 * @param {object} user
 * @returns {object[]}
 */
export function payableGroups(actors, actor, user) {
  const out = [];
  for ( const group of actors ?? [] ) {
    if ( canPayFrom({ group, actor, user }) ) out.push(group);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
