![](https://img.shields.io/badge/Foundry-v14.367-informational) 
![](https://img.shields.io/badge/D&D-v6.0.1-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/IainFielding/Simple-DnD-Magic-Shop/latest/module.zip?label=Downloads) [![Ko-fi](https://img.shields.io/badge/Ko--fi-sogrom?logo=ko-fi&logoColor=white)](https://ko-fi.com/sogrom)<br>

# Simple D&D Magic Shop

Traders your players can actually haggle with, for Foundry VTT and the D&D 5e system.

The GM stocks a Trader and pushes it to chat. A player clicks the card and a full-screen shop
opens — at *their* prices, because what an item costs depends on their character's Charisma and on
how much the Trader likes them. Buy, sell, or barter item-for-item; gold and goods move on both
sides, and the Trader's purse can run dry.

> **Feature complete and verified.** See [docs/PLAN.md](docs/PLAN.md) for the design and
> [docs/API.md](docs/API.md) for the module API. 373 unit tests and 546 end-to-end assertions
> against a live Foundry world, run with a GM and two player clients joined at once.

## Requirements

| | |
| --- | --- |
| Foundry VTT | v14 (verified 14.367) |
| Game system | D&D 5e **6.0.0** or later in the 6.x line |

## What it does

- **Traders are Actors the module owns.** Stock is real dnd5e items, so prices, rarity,
  attunement and tooltips all come for free, and quantity is just the item's own quantity.
  A Trader holds up to 150 different items by default (a world setting, up to 300); a stack of
  anything counts once.
- **Attitude, 0 to 100, per character per Trader.** It moves prices, and it gates stock a Trader
  will only show once it trusts you. It drifts up as a character spends, and the GM can set it
  directly.
- **Prices follow one model.** Charisma is the dominant term, goodwill is the second, and the
  curves are shaped so that buying an item and selling it straight back always loses money — no
  gold loop, in one shop or across every shop in the world.
- **The GM is the authority.** A player's client never computes a price it then gets to pay: it
  sends what it wants — item ids and quantities, nothing price-shaped — and a GM client derives
  the price, re-checks the stock, the purses and the buy filter, and settles. A trade is
  all-or-nothing: a refusal or a vetoed trade writes nothing at all, and a write that fails
  partway is undone. A GM with the game open in two tabs still settles each trade exactly once.
- **Trade and Barter.** Gold on one side, or goods against goods with coin balancing the
  difference. A sale and a purchase settle together, so trading the old sword toward the new one
  works even when the purse alone could not cover it.
- **Pay from the party fund.** A character in a dnd5e Group can pay from the Group's purse, when
  their player owns the Group. The GM grants that with ordinary Foundry ownership.
- **A ledger for every Trader.** Every settled trade is recorded: the GM sees all of them in the
  Trader Manager, and a player's shop shows them their own dealings with that Trader.
- **Archetypes.** Start a Trader as a Blacksmith, Apothecary, Arcanist, Fence or one of the other
  built-ins, stock its shelves in the same click, or save your own Trader as an archetype.
- **Stock a whole folder at once.** Drop a folder from a compendium or the Items sidebar, or a
  whole compendium, on the Trader Manager and everything in it, subfolders included, goes on the
  shelves after one confirmation.
- **Export and import.** Download a Trader, stock and all, and import it into another world. What
  it thinks of your players, and its ledger, stay behind.
- **Real magic items.** The Dungeon Master's Guide ships "Weapon, +1, +2, or +3" and Flame Tongue
  as templates with no weapon attached. Press **Magic item…** in the Stock tab (or drop a template
  on the Trader), choose the template, the enchantment and the
  base item, and the Trader stocks a real "Longsword +1". The generator and roll tables do the same
  at random, and **Spell scroll…** (or dropping a spell) stocks a real scroll of that spell.
- **See why a price is what it is.** Hover a price for where it comes from: the list value, the
  character's Charisma, the Trader's attitude. Gems, art objects and trade goods trade at full
  value, as the rules say.
- **Haggle.** A player picks Persuasion, Deception, Intimidation or Performance and makes the
  check, rolled by the GM's client for everyone to see. Success warms the Trader; failure cools it
  and rules that approach out until tomorrow.
- **Show to players.** One button opens the shop on every connected player's screen, each at
  their own character's prices.
- **Items change hands clean.** A player's pack shows what they have equipped or attuned, and a
  sold or bought item arrives unequipped and unattuned.

## Settings

Everything lives under *Configure Settings → Module Settings*, plus a **Manage Traders** button
that opens the Trader Manager. The pricing curve is a preset (Fair, Standard, Harsh, or your own
six numbers), and there are knobs for starting attitude, how fast spending earns goodwill, whether
the shop opens full screen or windowed, and whether the GM gets a toolbar button.

## What it does not guarantee

Foundry replicates every Actor document to every connected client — ownership gates opening a
sheet and writing to it, not the data arriving. So a player cannot open, edit or trade against a
Trader outside the shop, but a determined one could read its stock from the browser console.
**Reveal-at-attitude keeps premium stock out of the shop and out of the data a shop is built
from; it is not a secrecy control.** Everything about money is enforced properly — see
[docs/PLAN.md §6](docs/PLAN.md).

## Development

```bash
npm install
npm run check      # syntax, JSON, localisation keys, lint, unit tests
```

`npm run check` runs five gates. The localisation check is worth knowing about: there is no
build step, so a mistyped key renders in the live game as the raw key, and this catches it.

The end-to-end harness in `test-e2e/` drives a real Foundry install with a GM and **two player
clients joined at once** — the only way to test the permission boundary, and the reason this
harness exists rather than borrowing the character creator's.

```bash
cd test-e2e
npm install
cp config.example.mjs config.mjs    # then edit the paths
npm run link-module
npm run provision
npm test
```

Foundry locks its data directory, so close the desktop app before running it.

## Licence

Freeware — see [LICENSE](LICENSE). The bundled Cinzel and Spectral fonts are SIL OFL 1.1.

Unofficial fan content. Dungeons & Dragons and D&D are trademarks of Wizards of the Coast. This
module ships no game content of its own; it works with content you already own.
