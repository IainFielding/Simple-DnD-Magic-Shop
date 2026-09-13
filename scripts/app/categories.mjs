import { PHYSICAL_TYPES, t } from "../config.mjs";
import { categoryTokens } from "../data/generate.mjs";

/**
 * The item categories, as people read them: "Equipment", and beneath it "Heavy Armor".
 *
 * One definition shared by the Trader Manager's stock generator and the shop's type filter, so a
 * GM who builds a shop from "Armor and Musical Instruments" sees exactly those words again when
 * a player filters the shelves. The tokens themselves come from `data/generate.mjs#categoryTokens`
 * — a type, or a `type:subtype` pair — and this file only adds the labels and the order.
 */

/**
 * Where dnd5e keeps the subtype labels for each item type. Two shapes live in there: weapon,
 * equipment and tool types map to a plain label string, consumable and loot types to an object
 * with a `label` — {@link subtypeLabel} reads both.
 *
 * `container` is absent deliberately: its subtypes are backpack and chest sorts of thing, which
 * nobody builds a shop by, so containers are offered as a type with no rows beneath it.
 */
export const SUBTYPE_SOURCES = Object.freeze({
  weapon: "weaponTypes",
  equipment: "equipmentTypes",
  consumable: "consumableTypes",
  tool: "toolTypes",
  loot: "lootTypes"
});

/**
 * How many entries fall in each category. Every entry counts, under both of its tokens, so a
 * "Tools" heading and a "Musical Instrument" row beneath it both read correctly.
 * @param {{type: string, subtype?: string}[]} entries
 * @returns {Record<string, number>}
 */
export function countCategories(entries) {
  const counts = {};
  for ( const entry of entries ?? [] ) {
    for ( const token of categoryTokens(entry) ) counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

/** A subtype's label from either of dnd5e's two config shapes, localised. */
function subtypeLabel(entry) {
  const label = typeof entry === "string" ? entry : (entry?.label ?? "");
  return game.i18n.localize(label);
}

/**
 * One category token as a person reads it: "Weapon", or "Equipment: Heavy Armor".
 *
 * For a summary line, where there are no counts to build a tree from. A subtype dnd5e does not
 * list falls back to its raw key rather than disappearing, so an archetype naming a homebrew
 * subtype still says what it asks for.
 * @param {string} token  `type` or `type:subtype`.
 * @returns {string}
 */
export function categoryLabel(token) {
  const [type, subtype] = String(token ?? "").split(":");
  const typeLabel = game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type);
  if ( !subtype ) return typeLabel;
  const entry = CONFIG.DND5E?.[SUBTYPE_SOURCES[type]]?.[subtype];
  const label = entry ? subtypeLabel(entry) : subtype;
  return `${typeLabel}: ${label}`;
}

/**
 * The categories present in some counts, grouped by type in dnd5e's order, with only the types
 * and subtypes that actually have something in them.
 *
 * A subtype dnd5e does not list — a homebrew one — is still counted under its type, so filtering
 * by the type finds it; it just gets no row of its own, having no label to show.
 * @param {Record<string, number>} counts   From {@link countCategories} or generate's own counter.
 * @param {Set<string>} [chosen]            Tokens to mark as checked.
 * @returns {{value: string, label: string, count: number, checked: boolean,
 *            subtypes: object[], hasSubtypes: boolean}[]}
 */
export function categoryTree(counts, chosen = new Set()) {
  const groups = [];
  for ( const type of PHYSICAL_TYPES ) {
    const total = counts[type] ?? 0;
    if ( !total ) continue;

    const source = CONFIG.DND5E?.[SUBTYPE_SOURCES[type]] ?? {};
    const subtypes = Object.entries(source)
      .map(([key, entry]) => ({
        value: `${type}:${key}`,
        label: subtypeLabel(entry),
        count: counts[`${type}:${key}`] ?? 0,
        checked: chosen.has(`${type}:${key}`)
      }))
      .filter(sub => sub.count > 0)
      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));

    groups.push({
      value: type,
      label: game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type),
      count: total,
      checked: chosen.has(type),
      subtypes,
      hasSubtypes: subtypes.length > 0
    });
  }
  return groups;
}

/**
 * The options for a panel's type dropdown: "All items", then each type present with its
 * subtypes indented beneath it. A type is itself selectable — "Weapons" means any weapon —
 * which is why this is a flat list rather than `<optgroup>`s, whose headings cannot be chosen.
 * @param {{type: string, subtype?: string}[]} lines  The panel's lines.
 * @param {string} selected                           The current token, or "" for all.
 * @returns {{value: string, label: string, count: number, sub: boolean, selected: boolean}[]}
 */
export function categoryOptions(lines, selected = "") {
  if ( !lines?.length ) return [];
  const options = [{
    value: "", label: t("shop.allTypes"), count: lines.length, sub: false, selected: !selected
  }];
  for ( const group of categoryTree(countCategories(lines)) ) {
    options.push({ value: group.value, label: group.label, count: group.count, sub: false,
      selected: selected === group.value });
    for ( const sub of group.subtypes ) {
      options.push({ value: sub.value, label: sub.label, count: sub.count, sub: true,
        selected: selected === sub.value });
    }
  }
  return options;
}
