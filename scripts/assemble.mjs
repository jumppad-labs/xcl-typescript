#!/usr/bin/env node
/**
 * Assembles the nine npm tarballs of one release from the verified engine
 * archives: fills each platform package with its engine, sets every version,
 * and packs them.
 *
 * Usage: node scripts/assemble.mjs <archives-dir> <tag> [--out <dir>] [--no-build]
 *
 * The archives are those of the xcl release, already checked against its signed
 * checksums. The script runs from the package root and changes the working
 * tree, which in a release is a throwaway checkout.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Each platform package: its directory under npm/, its scoped name, and the asset name of its engine archive. */
const TARGETS = [
  { dir: "xcl-lang-linux-x64-gnu", name: "@jumppad-labs/xcl-lang-linux-x64-gnu", asset: "linux_amd64", windows: false },
  { dir: "xcl-lang-linux-x64-musl", name: "@jumppad-labs/xcl-lang-linux-x64-musl", asset: "linux_amd64_musl", windows: false },
  { dir: "xcl-lang-linux-arm64-gnu", name: "@jumppad-labs/xcl-lang-linux-arm64-gnu", asset: "linux_arm64", windows: false },
  { dir: "xcl-lang-linux-arm64-musl", name: "@jumppad-labs/xcl-lang-linux-arm64-musl", asset: "linux_arm64_musl", windows: false },
  { dir: "xcl-lang-darwin-x64", name: "@jumppad-labs/xcl-lang-darwin-x64", asset: "darwin_amd64", windows: false },
  { dir: "xcl-lang-darwin-arm64", name: "@jumppad-labs/xcl-lang-darwin-arm64", asset: "darwin_arm64", windows: false },
  { dir: "xcl-lang-win32-x64", name: "@jumppad-labs/xcl-lang-win32-x64", asset: "windows_amd64", windows: true },
  { dir: "xcl-lang-win32-arm64", name: "@jumppad-labs/xcl-lang-win32-arm64", asset: "windows_arm64", windows: true },
];

function parseArguments(argv) {
  const positional = [];
  let out = "build/packages";
  let build = true;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      index += 1;
      out = argv[index];
    } else if (argv[index] === "--no-build") {
      build = false;
    } else {
      positional.push(argv[index]);
    }
  }
  if (positional.length !== 2) {
    throw new Error("usage: assemble.mjs <archives-dir> <tag> [--out <dir>] [--no-build]");
  }
  return { archives: resolve(positional[0]), tag: positional[1], out: resolve(out), build };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Unpacks one engine archive and copies its program into the platform package. */
function fillPackage(target, archives, version) {
  const extension = target.windows ? "zip" : "tar.gz";
  const archive = join(archives, `xcl-core_${version}_${target.asset}.${extension}`);
  const program = target.windows ? "xcl-core.exe" : "xcl-core";
  const unpacked = mkdtempSync(join(tmpdir(), "xcl-assemble-"));
  try {
    if (target.windows) {
      execFileSync("unzip", ["-q", archive, "-d", unpacked]);
    } else {
      execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
    }
    const bin = join("npm", target.dir, "bin");
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(unpacked, program), join(bin, program));
    chmodSync(join(bin, program), 0o755);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

function setVersions(version, tag) {
  for (const target of TARGETS) {
    const path = join("npm", target.dir, "package.json");
    const manifest = readJson(path);
    manifest.version = version;
    writeJson(path, manifest);
  }

  const root = readJson("package.json");
  root.version = version;
  root.optionalDependencies = Object.fromEntries(TARGETS.map((target) => [target.name, version]));
  writeJson("package.json", root);

  const source = readFileSync("src/version.ts", "utf8")
    .replace(/ENGINE_VERSION = "[^"]*"/, `ENGINE_VERSION = "${tag}"`)
    .replace(/PACKAGE_VERSION = "[^"]*"/, `PACKAGE_VERSION = "${version}"`);
  writeFileSync("src/version.ts", source);
}

function pack(directory, out) {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: directory, stdio: ["ignore", "ignore", "inherit"] });
}

const { archives, tag, out, build } = parseArguments(process.argv.slice(2));
const version = tag.replace(/^v/, "");

mkdirSync(out, { recursive: true });
for (const target of TARGETS) {
  fillPackage(target, archives, version);
}
setVersions(version, `v${version}`);
if (build) {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
for (const target of TARGETS) {
  pack(join("npm", target.dir), out);
}
pack(".", out);
console.log(`assembled nine tarballs at ${version} in ${out}`);
