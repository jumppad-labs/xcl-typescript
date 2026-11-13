---
created_date: "2026-11-10"
document_status: draft
project: xclconfig
spec: 20261031080136-264e0eab-typescript-core-sdk
plan: 20261031080136-264e0eab-typescript-core-sdk
---

xcl now runs from Node. The `xcl-lang` package lets a TypeScript or JavaScript program read, check and apply configuration exactly as a Go program would, with the same Go plugins, types written as decorated classes and functions of its own. Long-running work never stalls the rest of the program, and an operation can be cancelled with an `AbortSignal` or, when asked, Ctrl-C.

> Derived from project xcl (https://github.com/jumppad-labs/xcl), spec/plan 20261031080136-264e0eab-typescript-core-sdk. See the project-level record for the full feature.

## What changed in this repo

- The package itself: a typed ES module for Node 22 and later, with `@bufbuild/protobuf` as its only runtime dependency and messages generated from xcl's protos at the pinned tag.
- The engine transport, typed client, operations, lookups and error classes.
- Decorated entity classes under both decorator modes, schema derivation, hydration, TypeScript functions, variables and encoding.
- Events, state stores, masks, cancellation and Ctrl-C.
- Eight platform packages and the script that assembles all nine tarballs.
- Unit, real-engine and Go parity test suites, a reusable test workflow and bump, tag and release workflows.
- A README, a parity record against the Go API, a runnable getting-started example, and doc comments on every export.

## Why

TypeScript developers could not use xcl. This repository is where its Node package lives, built on the same engine as Go and Python so results match Go's.

## Before the first release

A person must set up npm trusted publishing for the nine package names and the release bot App and its secrets. No workflow here has yet run on GitHub, and only Linux x86-64 has been tested.
