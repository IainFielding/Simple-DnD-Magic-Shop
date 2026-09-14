import { PHYSICAL_TYPES } from "../config.mjs";
import { isHollowTemplate } from "./enchant.mjs";

/**
 * Stocking a whole folder, or a whole pack, in one drop.
 *
 * Dropping a folder means "drop everything in it": gear goes on the shelf and a spell becomes a
 * scroll of itself, exactly as each would dropped alone. The one exception is a DMG template,
 * which on its own opens a dialog asking what to make. A folder of forty of them would be forty
 * dialogs in a row, so they are left out and the GM is told to drop the ones they want singly.
 */

/**
 * The ids of a folder and every folder beneath it, however deep.
 *
 * Walks the parent links rather than `Folder#getSubfolders`, which only ever looks in the world's
 * folders and so finds nothing inside a compendium.
 * @param {string} rootId
 * @param {{id: string, parent: string|null}[]} folders  Every folder alongside it.
 * @returns {Set<string>}
 */
export function descendantFolderIds(rootId, folders) {
  const ids = new Set([rootId]);
  let grew = true;
  while ( grew ) {
    grew = false;
    for ( const { id, parent } of folders ) {
      if ( ids.has(id) || !ids.has(parent) ) continue;
      ids.add(id);
      grew = true;
    }
  }
  return ids;
}

/**
 * Whether an item lives inside a container. The container is the thing to stock — an Explorer's
 * Pack, not its bedroll and its rope as loose lines beside it.
 * @param {object} item  A document or an index entry.
 * @returns {boolean}
 */
function isContained(item) {
  return !!(item?.system?.container);
}

/**
 * Sort the contents of a dropped folder by what happens to each.
 * @param {object[]} items  Loaded item documents.
 * @returns {{plain: object[], spells: object[], templates: object[], skipped: object[]}}
 *   `skipped` is what a Trader cannot stock at all: class features, backgrounds and the like.
 *   Items inside a container are left out of every list.
 */
export function sortDropped(items) {
  const sorted = { plain: [], spells: [], templates: [], skipped: [] };
  for ( const item of items ?? [] ) {
    if ( !item || isContained(item) ) continue;
    if ( item.type === "spell" ) sorted.spells.push(item);
    else if ( !PHYSICAL_TYPES.includes(item.type) ) sorted.skipped.push(item);
    else if ( isHollowTemplate(item) ) sorted.templates.push(item);
    else sorted.plain.push(item);
  }
  return sorted;
}

/**
 * Resolve a dropped folder or pack to the items inside it.
 *
 * Takes a world Item folder, a folder inside an Item compendium, or a whole Item compendium. For a
 * compendium, the index is filtered first so only what could be stocked is loaded; the documents
 * then land in the pack's cache, which is what makes the uuid lookups the stock path does next
 * instant rather than one server round trip each.
 * @param {object} data  Drop data of type "Folder" or "Compendium".
 * @returns {Promise<{name: string, items: object[]}|null>}  Null when it is not a folder of items.
 */
export async function droppedFolderItems(data) {
  if ( data?.type === "Compendium" ) {
    const pack = game.packs.get(data.collection);
    if ( pack?.documentName !== "Item" ) return null;
    return { name: pack.title, items: await loadFromPack(pack, () => true) };
  }

  if ( data?.type !== "Folder" ) return null;
  const folder = await fromUuid(data.uuid).catch(() => null);
  if ( folder?.type !== "Item" ) return null;

  if ( folder.pack ) {
    const pack = game.packs.get(folder.pack);
    if ( !pack ) return null;
    const ids = descendantFolderIds(folder.id, pack.folders.map(folderLink));
    return { name: folder.name, items: await loadFromPack(pack, entry => ids.has(entry.folder)) };
  }

  const ids = descendantFolderIds(folder.id, game.folders.filter(f => f.type === "Item").map(folderLink));
  const items = game.items.filter(item => ids.has(item.folder?.id));
  return { name: folder.name, items: byName(items) };
}

/** A folder as {@link descendantFolderIds} wants it. `_source` because `folder` is the resolved parent. */
function folderLink(folder) {
  return { id: folder.id, parent: folder._source.folder ?? null };
}

/**
 * Load the entries of a pack that pass a filter.
 *
 * Only what could be stocked is loaded. The rest comes back as bare index entries, which is all
 * {@link sortDropped} needs to count them as skipped.
 * @param {object} pack
 * @param {(entry: object) => boolean} include
 * @returns {Promise<object[]>}
 */
async function loadFromPack(pack, include) {
  const index = await pack.getIndex({ fields: ["system.container"] });
  const wanted = [];
  const unstockable = [];
  for ( const entry of index ) {
    if ( !include(entry) || isContained(entry) ) continue;
    if ( (entry.type === "spell") || PHYSICAL_TYPES.includes(entry.type) ) wanted.push(entry._id);
    else unstockable.push(entry);
  }
  const loaded = wanted.length ? await pack.getDocuments({ _id__in: wanted }) : [];
  return byName([...loaded, ...unstockable]);
}

/** Alphabetical, so which items miss out when the shelves fill up is predictable. */
function byName(items) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
