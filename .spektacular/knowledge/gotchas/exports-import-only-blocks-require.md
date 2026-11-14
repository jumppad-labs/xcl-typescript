---
tags: [npm, node, commonjs, esm, exports, packaging, typescript]
---

# An `import`-only `exports` map blocks `require()` even where Node can require ES modules

Node 22.12 and later can `require()` an ES module, but only if the package's `exports` map has a condition that `require()` matches. With only `"import"` listed, `require("xcl-lang")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` ("No \"exports\" main defined") on every Node version, whatever `require(esm)` support it has.

The fix needs one build, not two: add a `"default"` condition pointing at the same ES module file.

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  }
}
```

Conditions that go with it:

- `engines.node` must be `>=22.12`. Before that, `require(esm)` sat behind a flag.
- No module in the package's graph may use top-level `await`. `require()` refuses such a graph (`ERR_REQUIRE_ASYNC_MODULE`), so a top-level `await` added anywhere in `src` quietly breaks every CommonJS user.
- A separate CommonJS build is not needed. Shipping both an ES module and a CommonJS copy invites the dual-package hazard: two copies of each error class, so `instanceof` fails across them.

In xcl-typescript (2026-11-14) the `default` condition was added, `engines` raised to `>=22.12`, and `examples/getting-started-commonjs/main.js` written as plain CommonJS. `test.yml` and `release.yml` copy it into the installed project as `main.cjs` (the `.cjs` extension because that project's `package.json` is `"type": "module"`) and run it next to the TypeScript example. That run is what catches a top-level `await` or a lost `exports` condition.
