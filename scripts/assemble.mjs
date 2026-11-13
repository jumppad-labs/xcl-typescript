#!/usr/bin/env node
/**
 * Assembles the nine npm tarballs of one release from the verified engine
 * archives: fills each platform package with its engine, sets every version,
 * and packs them.
 *
 * Usage: node scripts/assemble.mjs <archives-dir> <engine-tag> <package-version> [--out <dir>] [--no-build]
 *
 * The package and the engine it bundles are versioned separately. The engine
 * tag is the xcl release pinned in xcl-ref.txt, such as v0.13.1: it names the
 * archives, xcl-core_0.13.1_<os>_<arch>[_musl], and is written to
 * src/version.ts as ENGINE_VERSION, the engine the package checks for. The
 * package version, such as 0.2.0, is every package's version, the version of
 * each optional dependency, and PACKAGE_VERSION.
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
  if (positional.length !== 3) {
    throw new Error("usage: assemble.mjs <archives-dir> <engine-tag> <package-version> [--out <dir>] [--no-build]");
  }
  const [archives, engineTag, packageVersion] = positional;
  if (!engineTag.startsWith("v")) {
    throw new Error(`the engine tag must be an xcl tag starting with v, such as v0.13.1, got ${engineTag}`);
  }
  if (packageVersion.startsWith("v")) {
    throw new Error(`the package version is a bare version, such as 0.2.0, got ${packageVersion}`);
  }
  return { archives: resolve(archives), engineTag, packageVersion, out: resolve(out), build };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Unpacks one engine archive, named by the engine's version, and copies its program into the platform package. */
function fillPackage(target, archives, engineVersion) {
  const extension = target.windows ? "zip" : "tar.gz";
  const archive = join(archives, `xcl-core_${engineVersion}_${target.asset}.${extension}`);
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

/** Sets every package to the package's version, and writes both versions into src/version.ts. */
function setVersions(packageVersion, engineTag) {
  for (const target of TARGETS) {
    const path = join("npm", target.dir, "package.json");
    const manifest = readJson(path);
    manifest.version = packageVersion;
    writeJson(path, manifest);
  }

  const root = readJson("package.json");
  root.version = packageVersion;
  root.optionalDependencies = Object.fromEntries(TARGETS.map((target) => [target.name, packageVersion]));
  writeJson("package.json", root);

  const source = readFileSync("src/version.ts", "utf8")
    .replace(/ENGINE_VERSION = "[^"]*"/, `ENGINE_VERSION = "${engineTag}"`)
    .replace(/PACKAGE_VERSION = "[^"]*"/, `PACKAGE_VERSION = "${packageVersion}"`);
  writeFileSync("src/version.ts", source);
}

function pack(directory, out) {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: directory, stdio: ["ignore", "ignore", "inherit"] });
}

const { archives, engineTag, packageVersion, out, build } = parseArguments(process.argv.slice(2));

mkdirSync(out, { recursive: true });
for (const target of TARGETS) {
  fillPackage(target, archives, engineTag.slice(1));
}
setVersions(packageVersion, engineTag);
if (build) {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
for (const target of TARGETS) {
  pack(join("npm", target.dir), out);
}
pack(".", out);
console.log(`assembled nine tarballs at ${packageVersion}, bundling the xcl engine ${engineTag}, in ${out}`);
