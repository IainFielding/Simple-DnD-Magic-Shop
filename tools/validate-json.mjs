/**
 * Fail-fast JSON validation for the files Foundry parses at load: the module manifest and
 * every language file. A stray trailing comma in `lang/en.json` silently breaks localisation
 * in the live game with no build step to catch it, so this parses them on every `npm run check`.
 *
 * `module.json` carries `#{VERSION}#`-style release tokens substituted at publish time; those
 * live *inside* JSON string values, so the file is still valid JSON as committed and parses
 * fine here.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const files = ["module.json", "lang/en.json"];

let failures = 0;
for ( const rel of files ) {
  const path = resolve(root, rel);
  try {
    JSON.parse(await readFile(path, "utf8"));
    console.log(`ok    ${rel}`);
  } catch ( err ) {
    failures++;
    console.error(`FAIL  ${rel}: ${err.message}`);
  }
}

if ( failures ) {
  console.error(`\n${failures} JSON file(s) failed to parse.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} JSON file(s) valid.`);
