/**
 * Check that the module, as it would be packaged, can actually load.
 *
 * Everything else in `npm run check` looks at source. None of it notices a template renamed on
 * disk but not in `tpl()`, a stylesheet listed in the manifest that was never committed, or a
 * font the CSS points at that is outside the folders the release zips. Each of those passes
 * every test and then fails in a player's browser as a 404 — so this reads the manifest, the
 * scripts and the stylesheets the way Foundry will, and checks each path exists **inside the
 * release file list**.
 *
 *   node tools/validate-package.mjs                  # the working tree
 *   node tools/validate-package.mjs --root=dist/x    # an unpacked release archive
 *   node tools/validate-package.mjs --release        # also require real release values
 *
 * `--root` is what makes it useful in the release workflow: pointed at the unzipped archive, it
 * proves the zip contains what the module loads, not merely that the repository does.
 *
 * `--release` additionally refuses `#{TOKEN}#` placeholders and a non-semver version, which is
 * right for a built archive and wrong for the repository, where the tokens are meant to be.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_FILES } from "./release-files.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const root = resolve(arg("root") ?? repo);
const release = process.argv.includes("--release");

const problems = [];
const fail = message => problems.push(message);

/** A path relative to the module root, with forward slashes. */
const rel = path => relative(root, path).split(sep).join("/");

/** Whether a module-relative path is covered by the release file list. */
function shipped(path) {
  const clean = normalize(path).split(sep).join("/");
  return RELEASE_FILES.some(entry => clean === entry || clean.startsWith(`${entry}/`));
}

/**
 * Whether a module-relative path exists **with exactly this spelling**.
 *
 * `existsSync` alone is not enough on Windows or macOS, where the filesystem ignores case: a
 * template referenced as `Shop/Footer.hbs` is found locally and 404s on a Linux server — which is
 * what most hosted Foundry installs run on. Each segment is checked against the real directory
 * listing instead.
 */
function existsExactly(path) {
  let dir = root;
  for ( const segment of path.split("/") ) {
    if ( !existsSync(dir) || !statSync(dir).isDirectory() ) return false;
    if ( !readdirSync(dir).includes(segment) ) return false;
    dir = join(dir, segment);
  }
  return true;
}

/** Require a module-relative file to exist and to be something the release zips. */
function requireFile(path, from) {
  if ( !shipped(path) ) fail(`${from} loads "${path}", which is outside the release file list`);
  if ( existsExactly(path) ) return;
  fail(existsSync(join(root, path))
    ? `${from} loads "${path}", which exists only with different capitalisation — it will 404 on Linux`
    : `${from} loads "${path}", which does not exist`);
}

function walk(dir, ext, out = []) {
  if ( !existsSync(dir) ) return out;
  for ( const name of readdirSync(dir) ) {
    const path = join(dir, name);
    if ( statSync(path).isDirectory() ) walk(path, ext, out);
    else if ( path.endsWith(ext) ) out.push(path);
  }
  return out;
}

/* --- The release file list itself ------------------------------------------------ */

for ( const entry of RELEASE_FILES ) {
  if ( !existsSync(join(root, entry)) ) fail(`release file list names "${entry}", which does not exist`);
}

/* --- The manifest ---------------------------------------------------------------- */

let manifest = {};
try {
  manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
} catch ( err ) {
  fail(`module.json does not parse: ${err.message}`);
}

for ( const key of ["id", "title", "description", "version", "compatibility", "authors",
  "url", "manifest", "download"] ) {
  if ( manifest[key] === undefined || manifest[key] === "" ) fail(`module.json has no "${key}"`);
}

for ( const path of manifest.esmodules ?? [] ) requireFile(path, "module.json esmodules");
for ( const path of manifest.styles ?? [] ) requireFile(path, "module.json styles");
for ( const lang of manifest.languages ?? [] ) requireFile(lang.path, `module.json language "${lang.lang}"`);
if ( manifest.license ) requireFile(manifest.license, "module.json license");

// The id is written in two places, and Foundry only loads a module whose folder, manifest id and
// template paths agree. A mismatch here renders every window as a 404.
const config = readFileSync(join(root, "scripts/config.mjs"), "utf8");
const codeId = config.match(/export const MODULE_ID\s*=\s*"([^"]+)"/)?.[1];
if ( codeId !== manifest.id ) {
  fail(`scripts/config.mjs MODULE_ID is "${codeId}" but module.json id is "${manifest.id}"`);
}

const tokens = JSON.stringify(manifest).match(/#\{[A-Z_]+\}#/g) ?? [];
if ( release ) {
  if ( tokens.length ) fail(`module.json still carries release placeholders: ${[...new Set(tokens)].join(", ")}`);
  if ( !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "") ) {
    fail(`module.json version "${manifest.version}" is not semver`);
  }
  for ( const key of ["url", "manifest", "download"] ) {
    if ( !/^https:\/\//.test(manifest[key] ?? "") ) fail(`module.json ${key} is not an https URL`);
  }
}

/* --- Templates the scripts render ------------------------------------------------ */

for ( const file of walk(join(root, "scripts"), ".mjs") ) {
  const source = readFileSync(file, "utf8");
  for ( const [, path] of source.matchAll(/\btpl\(\s*["'`]([^"'`$]+)["'`]\s*\)/g) ) {
    requireFile(`templates/${path}`, rel(file));
  }
}

/* --- Files the stylesheets pull in ----------------------------------------------- */

/** Files in other modules' folders, listed so they are visible rather than silently skipped. */
const external = new Set();

for ( const file of walk(join(root, "styles"), ".css") ) {
  const source = readFileSync(file, "utf8");
  for ( const [, raw] of source.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g) ) {
    if ( /^(data:|https?:|#)/.test(raw) ) continue;
    const path = rel(resolve(dirname(file), raw));
    // A path that climbs out of the module lands in *another* module's folder — the Ember skin
    // borrowing Ember's art, which we must never copy into our archive. It cannot be checked
    // from here; the end-to-end harness fetches those files on a machine that has the module.
    if ( path.startsWith("../") ) {
      external.add(`${path.slice(3)} (${rel(file)})`);
      continue;
    }
    requireFile(path, rel(file));
  }
}

/* --- Report ---------------------------------------------------------------------- */

if ( problems.length ) {
  for ( const problem of problems ) console.error(`FAIL  ${problem}`);
  console.error(`\n${problems.length} packaging problem(s) in ${root}.`);
  process.exit(1);
}
console.log(`Package ok: ${relative(process.cwd(), root) || "."}${release ? " (release values checked)" : ""}`);
if ( external.size ) {
  console.log(`  ${external.size} file(s) from other modules, not checked here:`);
  for ( const path of external ) console.log(`    ${path}`);
}
