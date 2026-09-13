/**
 * World setup that has to run *inside* Foundry: the player users and their characters.
 *
 * This is the part the Character Creator's harness has no equivalent for. Its worlds have the
 * single auto-created Gamemaster, which is enough to drive a character builder. The Magic Shop
 * is a GM-authoritative boundary crossed by player intent, so its suites need real player
 * clients with real owned characters — a forged-price refusal, hidden stock never reaching a
 * browser, two players racing for the last item: none of it is observable with one user.
 *
 * Runs in the browser with every Foundry global in scope. Idempotent: re-provisioning finds the
 * users and characters it made last time and leaves them alone.
 */

/** Characters the harness creates are named with this prefix, so cleanup can find them. */
const PREFIX = "[e2e]";

/**
 * Ensure each configured player exists, owns a character, and has it assigned.
 *
 * Passwordless, like the auto-created Gamemaster: the harness logs in by name and there is no
 * secret worth protecting in a disposable world.
 *
 * @param {{name: string, character: {name: string, cha: number}}[]} players
 * @returns {Promise<{name: string, id: string, character: string}[]>}
 */
export async function ensureUsers(players) {
  const out = [];

  for ( const spec of players ) {
    const character = await ensureCharacter(spec.character);
    let user = game.users.find(u => u.name === spec.name);

    if ( !user ) {
      user = await User.create({
        name: spec.name,
        role: CONST.USER_ROLES.PLAYER,
        character: character.id
      });
    } else if ( user.character?.id !== character.id ) {
      await user.update({ character: character.id });
    }

    // Ownership is what the shop's authorisation check actually tests against, and assigning a
    // character does *not* grant it — a GM can assign a character a player cannot even see. So
    // it is set explicitly, which is also what a real GM does when handing out a character.
    if ( character.ownership?.[user.id] !== CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER ) {
      await character.update({
        [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
      });
    }

    out.push({ name: user.name, id: user.id, character: character.name });
  }

  return out;
}

/**
 * Create or refresh one harness character.
 *
 * The Charisma score is the whole point of these two: the suites assert that the same item
 * costs the two of them different amounts, which is the pricing model's headline behaviour and
 * is only observable with two characters at opposite ends of the ability.
 *
 * Given a starting purse and a couple of sellable items so the selling half of the shop has
 * something to work with.
 * @param {{name: string, cha: number}} spec
 * @returns {Promise<object>}
 */
async function ensureCharacter({ name, cha }) {
  let actor = game.actors.find(a => a.name === name);

  if ( !actor ) {
    actor = await Actor.create({
      name,
      type: "character",
      img: "icons/svg/mystery-man.svg",
      system: {
        abilities: { cha: { value: cha } },
        // Enough to buy most things, in mixed denominations so the change-making path is
        // exercised rather than assumed.
        currency: { pp: 2, gp: 500, ep: 0, sp: 40, cp: 75 }
      }
    });
  } else {
    // Reset between runs: a previous run may have spent the purse or sold the gear.
    await actor.update({
      "system.abilities.cha.value": cha,
      "system.currency": { pp: 2, gp: 500, ep: 0, sp: 40, cp: 75 }
    });
  }

  await ensureStartingGear(actor);
  return actor;
}

/**
 * Give a character something to sell.
 *
 * Hand-built rather than pulled from a compendium, so the suites do not depend on which content
 * packs are enabled and so the prices are known exactly — a test asserting "this sells for 450
 * copper" needs an item whose value it chose.
 * @param {object} actor
 */
async function ensureStartingGear(actor) {
  // Prices in copper, converted to the gp figure dnd5e stores. The "Worthless Rock" is there
  // on purpose: an unpriced item must never appear as sellable, and that is easier to assert
  // against something built to have no value than against whatever a pack happens to contain.
  const wanted = [
    { name: `${PREFIX} Plain Sword`, type: "weapon", valueCp: 1000, qty: 1 },
    { name: `${PREFIX} Trinket`, type: "loot", valueCp: 500, qty: 4 },
    { name: `${PREFIX} Worthless Rock`, type: "loot", valueCp: 0, qty: 1 }
  ];

  const toCreate = [];
  for ( const spec of wanted ) {
    const existing = actor.items.find(i => i.name === spec.name);
    if ( existing ) {
      await existing.update({ "system.quantity": spec.qty });
      continue;
    }
    toCreate.push({
      name: spec.name,
      type: spec.type,
      img: "icons/svg/item-bag.svg",
      system: {
        quantity: spec.qty,
        price: { value: spec.valueCp / 100, denomination: "gp" }
      }
    });
  }
  if ( toCreate.length ) await actor.createEmbeddedDocuments("Item", toCreate);
}

/**
 * The harness's own long-lived fixtures, which a sweep must never remove: every suite that
 * shops needs a character to shop *as*, and they are only recreated by provisioning.
 */
const KEEP = new Set([`${PREFIX} Vex`, `${PREFIX} Thog`]);

/**
 * Remove whatever a previous run left behind.
 *
 * **Only things the harness made, identified by name.** An earlier version deleted every actor
 * flagged as a Trader, on the reasoning that this is a disposable test world. It is not
 * disposable to the person testing in it: GMs create their own Traders here to try the module
 * by hand, and a sweep that took those too would destroy real work to tidy up after a crash.
 *
 * Called before the suites run, so a run that died halfway — and so skipped its own teardown —
 * cannot leave stale Traders for the next run's assertions to trip over. The manager suite in
 * particular selects "the first Trader in the rail", and a leftover sorted ahead of its own.
 * @returns {Promise<{removed: string[]}>}
 */
export async function cleanup() {
  const leftovers = game.actors.filter(actor =>
    actor.name.startsWith(PREFIX) && !KEEP.has(actor.name));
  if ( leftovers.length ) await Actor.deleteDocuments(leftovers.map(a => a.id));

  // World items and tables the roll-table suite makes.
  const items = game.items.filter(item => item.name.startsWith(PREFIX));
  if ( items.length ) await Item.deleteDocuments(items.map(i => i.id));
  const tables = game.tables.filter(table => table.name.startsWith(PREFIX));
  if ( tables.length ) await RollTable.deleteDocuments(tables.map(t => t.id));

  const messages = game.messages.filter(message =>
    message.getFlag("sogrom-simple-dnd5e-magic-shop", "card")
    && message.content?.includes(PREFIX));
  if ( messages.length ) await ChatMessage.deleteDocuments(messages.map(m => m.id));

  return { removed: [...leftovers, ...items, ...tables].map(doc => doc.name) };
}
