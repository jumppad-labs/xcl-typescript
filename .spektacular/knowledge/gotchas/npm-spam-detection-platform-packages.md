---
tags: [npm, publishing, release, typescript]
---

# npm's spam detection blocks runs of similar unscoped package names

Publishing many near-identical unscoped names in quick succession can trip npm's spam detection. The registry then refuses the publish with `403 Forbidden ... Package name triggered spam detection`, and retrying the same name keeps failing. For xcl, six `xcl-lang-<platform>` placeholders published and the two `xcl-lang-win32-*` names were refused minutes later, whatever version or metadata they carried.

Publish per-platform native packages under an npm organisation scope you own, and keep only the package users install unscoped. That is why the engine packages are `@jumppad-labs/xcl-lang-<os>-<arch>[-<libc>]`, as esbuild uses `@esbuild/<platform>`, while `xcl-lang` stays unscoped. Names under an owned scope cannot be taken by anyone else, and a scoped package's tarball packs as `jumppad-labs-<name>-<version>.tgz`, which the release and test workflows rely on.

Two other things refuse a first publish from a person's account:

- npm requires two-factor authentication (a passkey or authenticator) on the publishing account, so a placeholder publish fails with a 403 until it is turned on.
- npm requires `--tag` when publishing a prerelease version such as `0.0.0-stage`, and it refused a prerelease outright as the first version of a new scoped package (`403 ... You cannot publish using the version: 0.0.0-stage`, with the package not yet existing). A plain placeholder version such as `0.0.1`, which no release can clash with, publishes.

The release workflow itself needs no npm token: it publishes through each package's trusted publisher, which can only be added once the package exists.
