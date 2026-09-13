/**
 * Parse every shipped script with V8, so a file that cannot even load is caught here rather
 * than in the browser console.
 *
 * This is not redundant with ESLint. ESLint parses with espree, which accepts some things V8
 * rejects as *early errors* — the one that prompted this file being a `#private` member
 * referenced but never declared, which espree treats as a scoping question it does not resolve
 * and V8 refuses outright with "Private field '#x' must be declared in an enclosing class".
 * That error takes the whole module down at load time, so it is worth 100 ms to rule out.
 *
 * `node --check` is deliberately a subprocess rather than an import: importing these modules
 * would execute them, and they reach for Foundry globals at module scope.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.mjs` we ship or lint, excluding dependencies. */
async function scripts(dir, out = []) {
  for ( const entry of await readdir(dir, { withFileTypes: true }) ) {
    if ( entry.name === "node_modules" || entry.name.startsWith(".") ) continue;
    const path = join(dir, entry.name);
    if ( entry.isDirectory() ) await scripts(path, out);
    else if ( extname(entry.name) === ".mjs" ) out.push(path);
  }
  return out;
}

const files = await scripts(root);
let failures = 0;

await Promise.all(files.map(async file => {
  const rel = relative(root, file).replaceAll("\\", "/");
  try {
    await run(process.execPath, ["--check", file]);
  } catch ( err ) {
    failures++;
    // stderr carries the frame and the caret, which is the useful part.
    console.error(`FAIL  ${rel}\n${err.stderr?.trim() ?? err.message}\n`);
  }
}));

if ( failures ) {
  console.error(`${failures} of ${files.length} file(s) failed to parse.`);
  process.exit(1);
}
console.log(`All ${files.length} script(s) parse.`);
