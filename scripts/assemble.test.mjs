import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./assemble.mjs", import.meta.url));
const ROOT = resolve(dirname(SCRIPT), "..");
const VERSION = "1.2.3";

const UNIX_ASSETS = ["linux_amd64", "linux_amd64_musl", "linux_arm64", "linux_arm64_musl", "darwin_amd64", "darwin_arm64"];
const WINDOWS_ASSETS = ["windows_amd64", "windows_arm64"];

/** A copy of the package files the script changes, with fake engine archives, assembled once. */
function assembled(t) {
  const directory = mkdtempSync(join(tmpdir(), "xcl-assemble-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const project = join(directory, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "dist"));
  writeFileSync(join(project, "dist", "index.js"), "export {};\n");
  cpSync(join(ROOT, "package.json"), join(project, "package.json"));
  cpSync(join(ROOT, "npm"), join(project, "npm"), { recursive: true });
  cpSync(join(ROOT, "src", "version.ts"), join(project, "src", "version.ts"));

  const archives = join(directory, "archives");
  mkdirSync(archives);
  for (const asset of UNIX_ASSETS) {
    const unpacked = join(directory, `unpacked-${asset}`);
    mkdirSync(unpacked);
    writeFileSync(join(unpacked, "xcl-core"), `engine for ${asset}\n`);
    chmodSync(join(unpacked, "xcl-core"), 0o600);
    execFileSync("tar", ["-czf", join(archives, `xcl-core_${VERSION}_${asset}.tar.gz`), "-C", unpacked, "xcl-core"]);
  }
  for (const asset of WINDOWS_ASSETS) {
    const unpacked = join(directory, `unpacked-${asset}`);
    mkdirSync(unpacked);
    writeFileSync(join(unpacked, "xcl-core.exe"), `engine for ${asset}\n`);
    execFileSync("zip", ["-q", "-j", join(archives, `xcl-core_${VERSION}_${asset}.zip`), join(unpacked, "xcl-core.exe")]);
  }

  const out = join(directory, "out");
  execFileSync(process.execPath, [SCRIPT, archives, `v${VERSION}`, "--out", out, "--no-build"], { cwd: project, stdio: "pipe" });
  return { project, out };
}

function tarballEntries(tarball) {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
}

function manifestOf(tarball) {
  return JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
}

function engineText(tarball, program) {
  return execFileSync("tar", ["-xzOf", tarball, `package/bin/${program}`], { encoding: "utf8" });
}

function listingOf(tarball, program) {
  return execFileSync("tar", ["-tvzf", tarball, `package/bin/${program}`], { encoding: "utf8" });
}

test("the script produces nine tarballs", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  assert.deepEqual(readdirSync(out).sort(), [
    "xcl-lang-1.2.3.tgz",
    "xcl-lang-darwin-arm64-1.2.3.tgz",
    "xcl-lang-darwin-x64-1.2.3.tgz",
    "xcl-lang-linux-arm64-gnu-1.2.3.tgz",
    "xcl-lang-linux-arm64-musl-1.2.3.tgz",
    "xcl-lang-linux-x64-gnu-1.2.3.tgz",
    "xcl-lang-linux-x64-musl-1.2.3.tgz",
    "xcl-lang-win32-arm64-1.2.3.tgz",
    "xcl-lang-win32-x64-1.2.3.tgz",
  ]);
});

test("every tarball carries the one version", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  for (const tarball of readdirSync(out)) {
    assert.equal(manifestOf(join(out, tarball)).version, VERSION, tarball);
  }
});

test("each platform package holds the engine of its own platform", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  assert.equal(engineText(join(out, "xcl-lang-linux-x64-gnu-1.2.3.tgz"), "xcl-core"), "engine for linux_amd64\n");
  assert.equal(engineText(join(out, "xcl-lang-linux-x64-musl-1.2.3.tgz"), "xcl-core"), "engine for linux_amd64_musl\n");
  assert.equal(engineText(join(out, "xcl-lang-linux-arm64-gnu-1.2.3.tgz"), "xcl-core"), "engine for linux_arm64\n");
  assert.equal(engineText(join(out, "xcl-lang-linux-arm64-musl-1.2.3.tgz"), "xcl-core"), "engine for linux_arm64_musl\n");
  assert.equal(engineText(join(out, "xcl-lang-darwin-x64-1.2.3.tgz"), "xcl-core"), "engine for darwin_amd64\n");
  assert.equal(engineText(join(out, "xcl-lang-darwin-arm64-1.2.3.tgz"), "xcl-core"), "engine for darwin_arm64\n");
  assert.equal(engineText(join(out, "xcl-lang-win32-x64-1.2.3.tgz"), "xcl-core.exe"), "engine for windows_amd64\n");
  assert.equal(engineText(join(out, "xcl-lang-win32-arm64-1.2.3.tgz"), "xcl-core.exe"), "engine for windows_arm64\n");
});

test("the engine is executable inside its package", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  assert.match(listingOf(join(out, "xcl-lang-linux-x64-gnu-1.2.3.tgz"), "xcl-core"), /^-rwxr-xr-x/);
  assert.match(listingOf(join(out, "xcl-lang-win32-x64-1.2.3.tgz"), "xcl-core.exe"), /^-rwxr-xr-x/);
});

test("a Linux package declares its operating system, CPU and C library", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  const manifest = manifestOf(join(out, "xcl-lang-linux-arm64-musl-1.2.3.tgz"));

  assert.deepEqual(manifest.os, ["linux"]);
  assert.deepEqual(manifest.cpu, ["arm64"]);
  assert.deepEqual(manifest.libc, ["musl"]);
});

test("a glibc package declares glibc", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  assert.deepEqual(manifestOf(join(out, "xcl-lang-linux-x64-gnu-1.2.3.tgz")).libc, ["glibc"]);
});

test("a macOS package declares its operating system and CPU and no C library", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  const manifest = manifestOf(join(out, "xcl-lang-darwin-x64-1.2.3.tgz"));

  assert.deepEqual(manifest.os, ["darwin"]);
  assert.deepEqual(manifest.cpu, ["x64"]);
  assert.equal(manifest.libc, undefined);
});

test("a Windows package declares its operating system and CPU and no C library", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  const manifest = manifestOf(join(out, "xcl-lang-win32-arm64-1.2.3.tgz"));

  assert.deepEqual(manifest.os, ["win32"]);
  assert.deepEqual(manifest.cpu, ["arm64"]);
  assert.equal(manifest.libc, undefined);
});

test("xcl-lang lists all eight as optional dependencies at the same version", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  assert.deepEqual(manifestOf(join(out, "xcl-lang-1.2.3.tgz")).optionalDependencies, {
    "xcl-lang-linux-x64-gnu": VERSION,
    "xcl-lang-linux-x64-musl": VERSION,
    "xcl-lang-linux-arm64-gnu": VERSION,
    "xcl-lang-linux-arm64-musl": VERSION,
    "xcl-lang-darwin-x64": VERSION,
    "xcl-lang-darwin-arm64": VERSION,
    "xcl-lang-win32-x64": VERSION,
    "xcl-lang-win32-arm64": VERSION,
  });
});

test("the package's version constants are written from the tag", { skip: process.platform === "win32" }, (t) => {
  const { project } = assembled(t);

  const source = readFileSync(join(project, "src", "version.ts"), "utf8");

  assert.match(source, /ENGINE_VERSION = "v1\.2\.3"/);
  assert.match(source, /PACKAGE_VERSION = "1\.2\.3"/);
});

test("xcl-lang's tarball carries its build", { skip: process.platform === "win32" }, (t) => {
  const { out } = assembled(t);

  assert.ok(tarballEntries(join(out, "xcl-lang-1.2.3.tgz")).includes("package/dist/index.js"));
});

test("a missing archive fails the script", { skip: process.platform === "win32" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xcl-assemble-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archives = join(directory, "archives");
  mkdirSync(archives);

  assert.throws(() => execFileSync(process.execPath, [SCRIPT, archives, "v1.2.3", "--no-build"], { cwd: directory, stdio: "pipe" }));
});
