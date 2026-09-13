/**
 * Build the release: `dist/module.json` and `dist/module.zip`, exactly as GitHub will serve them.
 *
 *   npm run package                                           # a local trial build, 0.0.0-dev
 *   node tools/build-release.mjs --version=1.2.0 --repo=IainFielding/Simple-DnD-Magic-Shop --tag=v1.2.0
 *
 * The release workflow calls this, and so does CI on every push, so the archive a release ships
 * is built by the same code that has already been exercised on every commit before it.
 *
 * ## Why Node rather than `zip` and `jq`
 *
 * The sister module packages with the `zip` CLI and a token-replacement action. Both work on a
 * GitHub runner and neither exists on a Windows machine, which meant a release could only ever
 * be tried by publishing one. This has no dependencies — `zlib` does the compression and the
 * CRC — so `npm run package` produces the real archive anywhere Node runs.
 *
 * ## What changes between the repository and the release
 *
 * Only the manifest. The committed `module.json` carries `#{VERSION}#`-style placeholders; the
 * built one has the version, the project URL, a manifest URL that always resolves to the latest
 * release (Foundry's update check depends on it never changing), and a download URL pinned to
 * this release's archive. The repository copy is never modified.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { RELEASE_FILES } from "./release-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const version = arg("version") ?? "0.0.0-dev";
const repo = arg("repo") ?? "IainFielding/Simple-DnD-Magic-Shop";
const tag = arg("tag") ?? `v${version}`;
const out = resolve(root, arg("out") ?? "dist");

if ( !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ) {
  console.error(`"${version}" is not a semver version (expected e.g. 1.2.3 or 1.2.3-beta.1).`);
  process.exit(1);
}
if ( !/^[\w.-]+\/[\w.-]+$/.test(repo) ) {
  console.error(`"${repo}" is not an owner/name repository.`);
  process.exit(1);
}

/* --- The manifest ---------------------------------------------------------------- */

const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
Object.assign(manifest, {
  version,
  url: `https://github.com/${repo}`,
  manifest: `https://github.com/${repo}/releases/latest/download/module.json`,
  download: `https://github.com/${repo}/releases/download/${tag}/module.zip`
});
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

/* --- The file list --------------------------------------------------------------- */

/** OS litter that must never reach a player's modules folder. */
const LITTER = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function collect(path, files = []) {
  const stat = statSync(path);
  if ( stat.isDirectory() ) {
    for ( const name of readdirSync(path).sort() ) {
      if ( LITTER.has(name) ) continue;
      collect(join(path, name), files);
    }
  } else {
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files;
}

const files = RELEASE_FILES.flatMap(entry => collect(join(root, entry)));

/* --- The archive ----------------------------------------------------------------- */

/**
 * A minimal zip writer: deflated entries, UTF-8 names, no directories, no zip64. That is the
 * whole of what Foundry's installer needs, and the module is nowhere near the 4 GB where zip64
 * would matter — the size check below stops a build that ever got there.
 */
function zip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const UTF8 = 0x0800;
  const DEFLATE = 8;

  const locals = [];
  const central = [];
  let offset = 0;

  for ( const { name, data } of entries ) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...locals, centralBuffer, end]);
  if ( archive.length >= 0xFFFFFFFF || entries.length >= 0xFFFF ) {
    throw new Error("The archive needs zip64, which this writer does not do.");
  }
  return archive;
}

const entries = files.map(name => ({
  name,
  // The archive carries the built manifest, never the placeholder one.
  data: name === "module.json" ? Buffer.from(manifestText, "utf8") : readFileSync(join(root, name))
}));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "module.json"), manifestText);
writeFileSync(join(out, "module.zip"), zip(entries));

const kb = Math.round(statSync(join(out, "module.zip")).size / 1024);
console.log(`Built ${manifest.id} ${version} (${tag}): ${files.length} files, ${kb} KB`);
console.log(`  ${relative(root, join(out, "module.json"))}`);
console.log(`  ${relative(root, join(out, "module.zip"))}`);
console.log(`  download -> ${manifest.download}`);
