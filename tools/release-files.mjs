/**
 * What goes into the release archive, and nothing else.
 *
 * One list, read by both the release workflow (which zips exactly these) and
 * `validate-package.mjs` (which fails if the module loads anything outside them). Keeping it in
 * the workflow's YAML instead would mean a new top-level folder could be referenced by the code,
 * pass every test, and ship missing — the sister module's release step says as much in a comment,
 * and a comment is not a check.
 *
 * Run directly, it prints one path per line for the shell:
 *
 *   zip --recurse-paths module.zip $(node tools/release-files.mjs)
 */

import { fileURLToPath } from "node:url";

export const RELEASE_FILES = Object.freeze([
  "module.json",
  "README.md",
  "LICENSE",
  "scripts",
  "styles",
  "fonts",
  "lang",
  "templates"
]);

if ( process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] ) {
  console.log(RELEASE_FILES.join("\n"));
}
