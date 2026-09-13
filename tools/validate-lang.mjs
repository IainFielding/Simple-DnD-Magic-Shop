/**
 * Check that every localisation key the code and templates ask for actually exists.
 *
 * There is no build step, so a mistyped key is not an error — it renders in the live game as
 * the raw key ("sogrom-simple-dnd5e-magic-shop.manager.stock.qtyy"), which looks like a broken
 * module and is easy to miss in a window with sixty labels on it. This finds them in one pass.
 *
 * Two directions, both worth knowing about:
 *   missing  — asked for but not in lang/en.json. Always a bug.
 *   unused   — in lang/en.json but nothing asks for it. Usually dead weight left by a rename,
 *              occasionally a key built at runtime, so this warns rather than fails.
 *
 * Keys assembled at runtime (`t(`attitude.tier.${key}`)`) cannot be read statically. Those are
 * declared in DYNAMIC_PREFIXES below, and everything under such a prefix is treated as used.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ID = "sogrom-simple-dnd5e-magic-shop";

/**
 * Key prefixes built at runtime from a variable, so no static scan can see the leaves. Each
 * entry means "every key under this path is considered used".
 */
const DYNAMIC_PREFIXES = [
  // attitude.tier.<tier key>, from attitudeTier()
  "attitude.tier",
  // settings.displayMode.<mode>, from the choices map built over DISPLAY_MODES
  "settings.displayMode",
  // reject.<reason>, from acceptsItem()'s reason keys
  "reject",
  // pricing.error.<rule>, from validateAnchors()'s error keys
  "pricing.error",
  // manager.tab.<tab id>, from the TABS map
  "manager.tab",
  // rarity.<normalised rarity>, from the generator's bucket labels
  "rarity",
  // manager.trading.restock.<mode>, from the RESTOCK_MODES map
  "manager.trading.restock",
  // archetype.builtIn.<id>.name/.hint, built in data/archetypes.mjs for each built-in archetype
  "archetype.builtIn",
  // error.import.<reason>, from parseTraderExport()'s error keys
  "error.import"
];

/** Every file we scan for key references. */
async function sourceFiles(dir, out = []) {
  for ( const entry of await readdir(dir, { withFileTypes: true }) ) {
    // `dist` holds a built copy of the module; scanning it would report everything twice.
    if ( ["node_modules", "dist"].includes(entry.name) || entry.name.startsWith(".") ) continue;
    const path = join(dir, entry.name);
    if ( entry.isDirectory() ) await sourceFiles(path, out);
    else if ( [".mjs", ".hbs"].includes(extname(entry.name)) ) out.push(path);
  }
  return out;
}

/** Flatten the language file to dotted keys. */
function flatten(object, prefix = "", out = new Set()) {
  for ( const [key, value] of Object.entries(object) ) {
    const path = prefix ? `${prefix}.${key}` : key;
    if ( value && typeof value === "object" ) flatten(value, path, out);
    else out.add(path);
  }
  return out;
}

const lang = JSON.parse(await readFile(resolve(root, "lang/en.json"), "utf8"));
const declared = flatten(lang[MODULE_ID] ?? {});

/*
 * Three ways a key is written, and all three have to be recognised:
 *   {{localize "sogrom-simple-dnd5e-magic-shop.foo.bar"}}   templates, fully qualified
 *   t("foo.bar")                                            scripts, via config.mjs#t
 *   `${MODULE_ID}.foo.bar`                                  window titles and the like
 */
const FULL = new RegExp(`${MODULE_ID.replaceAll("-", "\\-")}\\.([A-Za-z0-9_.]+)`, "g");
const SHORT = /\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g;
// `${MODULE_ID}.foo.bar` inside a template literal: the prefix is a variable there, so FULL
// cannot see it.
const INTERPOLATED = /\$\{MODULE_ID\}\.([A-Za-z0-9_.]+)/g;

const asked = new Map();
for ( const file of await sourceFiles(root) ) {
  const text = await readFile(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");
  if ( rel.startsWith("tools/") ) continue;          // this file names keys in its own comments
  for ( const re of [FULL, SHORT, INTERPOLATED] ) {
    for ( const match of text.matchAll(re) ) {
      // A trailing dot comes from a template literal boundary, e.g. `attitude.tier.${key}`.
      const key = match[1].replace(/\.$/, "");
      // `${MODULE_ID}.` also prefixes things that are not localisation keys at all — the
      // module's query names and its flag scope. Every real key here is sectioned, so a
      // single bare segment is one of those rather than a missing translation.
      if ( !key.includes(".") ) continue;
      if ( !asked.has(key) ) asked.set(key, rel);
    }
  }
}

const dynamic = key => DYNAMIC_PREFIXES.some(p => key === p || key.startsWith(`${p}.`));

const missing = [...asked].filter(([key]) => !declared.has(key) && !dynamic(key));
const unused = [...declared].filter(key => !asked.has(key) && !dynamic(key));

for ( const [key, file] of missing ) console.error(`MISSING  ${key}  (${file})`);
for ( const key of unused ) console.warn(`unused   ${key}`);

console.log(`\n${declared.size} keys declared, ${asked.size} referenced, `
  + `${missing.length} missing, ${unused.length} unused.`);

if ( missing.length ) {
  console.error(`\n${missing.length} localisation key(s) are referenced but not declared.`);
  process.exit(1);
}
