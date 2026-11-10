# xcl for TypeScript

[xcl](https://github.com/jumppad-labs/xcl) for Node.js. `xcl-lang` runs the same engine Go and Python use, so a Node program reads, checks and applies configuration exactly as a Go program would, with the same Go plugins. Types are decorated classes, functions can be written in TypeScript, and long-running work never stalls the rest of your program.

## Install

```sh
npm install xcl-lang
```

Node 22 or later. The package is ES module only and fully typed.

Nothing else is needed: no Go, no C compiler, and nothing is downloaded on first use. The engine comes from a platform package installed alongside `xcl-lang`.

| Platform | Engine package |
|---|---|
| Linux x86-64, glibc | `xcl-lang-linux-x64-gnu` |
| Linux x86-64, musl | `xcl-lang-linux-x64-musl` |
| Linux arm64, glibc | `xcl-lang-linux-arm64-gnu` |
| Linux arm64, musl | `xcl-lang-linux-arm64-musl` |
| macOS x86-64 | `xcl-lang-darwin-x64` |
| macOS arm64 | `xcl-lang-darwin-arm64` |
| Windows x86-64 | `xcl-lang-win32-x64` |
| Windows arm64 | `xcl-lang-win32-arm64` |

These are `optionalDependencies`, so `--omit=optional`, `--no-optional` or a lockfile made on another platform leaves yours out. The first use then throws `EngineNotFoundError`, naming the package and how to install it.

## Getting started

This applies a configuration using a Go plugin, published as a signed GitHub release and installed on first use.

`main.xcl`:

```hcl
test "item" "first" {
  log   = "operations.log"
  value = "one"
}

test "item" "second" {
  log   = "operations.log"
  value = "two"
  input = test.item.first.output
}
```

`main.ts`:

```ts
import { readFileSync } from "node:fs";

import { createConfig, GitHubRegistry } from "xcl-lang";

// the jumppad-labs release key, from https://xcl.dev/keys/jumppad-labs-releases.asc
const releaseKey = readFileSync("jumppad-labs-releases.asc", "utf8");

const github = new GitHubRegistry({ trustedKeys: [releaseKey] });
github.registerPlugin("jumppad-labs/xcl-plugin-test", "v0.3.1");

await using config = await createConfig({ registries: [github], statePath: ".xcl" });

await config.apply("main.xcl");

const item = await config.find("test.item.second");
console.log(item.meta.id, item.attributes.value, item.attributes.input);
```

The complete project is in [`examples/getting-started`](examples/getting-started), and CI runs it. `await using` closes the configuration when the block ends; `await config.close()` does the same by hand.

## Your own types

Describe a block as a decorated class, and lookups return instances of it. The decorators work with TypeScript's standard decorators and with `experimentalDecorators`, with no setting to change.

```ts
import { Attribute, Block, createConfig, Entity, Int, LocalRegistry, Meta, Sensitive } from "xcl-lang";

class Health {
  @Attribute(String)
  path = "/";
}

@Entity("app")
class App {
  @Meta()
  meta!: Meta;

  @Attribute(String)
  image!: string;

  @Attribute(Int)
  replicas = 2;

  @Sensitive(String, { optional: true })
  password?: Sensitive<string>;

  @Block(() => Health, { optional: true })
  health?: Health;
}

const local = new LocalRegistry();
local.register(App);

await using config = await createConfig({ registries: [local], statePath: ".xcl" });
await config.apply("./infra");

const web = await config.find(App, "app.web");
console.log(web.image, web.replicas, `${web.password}`);
```

A field with no initializer is required, and an initializer makes it optional with that default. Properties are camelCase in TypeScript and snake_case in configuration. A class with no constructor arguments is required, because xcl constructs it to read its fields, and anything wrong with a definition throws `SchemaError` from `register`, naming the class and field.

## Functions

```ts
import { Func } from "xcl-lang";

class Functions {
  @Func([String], String)
  slugify(title: string): string {
    return title.toLowerCase().replaceAll(" ", "-");
  }
}

local.registerFunctions(new Functions());
```

Configuration calls it as `slugify("My App")`. A function may return a Promise.

## Long-running work

Every operation returns a Promise and the event loop keeps running while it does.

```ts
const controller = new AbortController();
await config.apply("./infra", { signal: controller.signal });
```

Aborting stops the operation in the engine and keeps the state saved so far, and the Promise rejects with `CancelledError`. A provider call already in flight is allowed to finish first. The package never listens for Ctrl-C unless you ask for it, one operation at a time:

```ts
import { interruptSignal } from "xcl-lang";

await config.apply("./infra", { signal: interruptSignal() });
```

## More

- Events, state stores and encryption: the `onEvent`, `stateStore` and `stateMask` options of `createConfig`.
- Errors are classes, one per kind, all `instanceof XclError`.
- [`PARITY.md`](PARITY.md) lists every Go operation and lookup with its TypeScript equivalent.

## Engine

One engine runs per process, and one per worker thread, started on first use and shared by every configuration there. An idle engine never keeps Node alive, and it exits when your program does, however your program ends. `XCL_CORE_PATH` runs a source build of the engine instead of the platform package.

The npm version equals the xcl release it bundles.

## License

Apache-2.0
