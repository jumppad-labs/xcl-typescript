# xcl for TypeScript

[xcl](https://github.com/jumppad-labs/xcl) for Node.js. `xcl-lang` runs the same engine Go and Python use, so a Node program reads, checks and applies configuration exactly as a Go program would, with the same Go plugins. Types are decorated classes, functions can be written in TypeScript, and long-running work never stalls the rest of your program.

## Install

```sh
npm install xcl-lang
```

Node 22.12 or later. The package is an ES module and fully typed, and CommonJS code can load it with `require("xcl-lang")`.

Nothing else is needed: no Go, no C compiler, and nothing is downloaded on first use. The engine comes from a platform package installed alongside `xcl-lang`.

| Platform | Engine package |
|---|---|
| Linux x86-64, glibc | `@jumppad-labs/xcl-lang-linux-x64-gnu` |
| Linux x86-64, musl | `@jumppad-labs/xcl-lang-linux-x64-musl` |
| Linux arm64, glibc | `@jumppad-labs/xcl-lang-linux-arm64-gnu` |
| Linux arm64, musl | `@jumppad-labs/xcl-lang-linux-arm64-musl` |
| macOS x86-64 | `@jumppad-labs/xcl-lang-darwin-x64` |
| macOS arm64 | `@jumppad-labs/xcl-lang-darwin-arm64` |
| Windows x86-64 | `@jumppad-labs/xcl-lang-win32-x64` |
| Windows arm64 | `@jumppad-labs/xcl-lang-win32-arm64` |

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

import { Config, EventDataLevel, GitHubRegistry, prettylog } from "xcl-lang";

// the jumppad-labs release key, from https://xcl.dev/keys/jumppad-labs-releases.asc
const releaseKey = readFileSync("jumppad-labs-releases.asc", "utf8");

const github = new GitHubRegistry({ trustedKeys: [releaseKey] });
github.registerPlugin("jumppad-labs/xcl-plugin-test", "v0.3.1");

await using config = new Config({
  registries: [github],
  statePath: ".xcl",
  // a readable line per event on standard error, at the level XCL_LOG_LEVEL sets
  onEvent: prettylog.handler({ level: prettylog.levelFromEnv() }),
  // puts each created entity's configuration beneath its line
  eventData: EventDataLevel.Processed,
});

await config.apply("main.xcl");

const item = await config.find("test.item.second");
console.log(item.meta.id, item.attributes.value, item.attributes.input);
```

The complete project is in [`examples/getting-started`](examples/getting-started), and CI runs it. The same program as plain CommonJS JavaScript, loading the package with `require()`, is in [`examples/getting-started-commonjs`](examples/getting-started-commonjs); CI runs that too. `await using` closes the configuration when the block ends; `await config.close()` does the same by hand. The pretty logger shows each step of the apply on standard error; see [Pretty logger](#pretty-logger) for its options.

## Your own types

Describe a block as a decorated class, and lookups return instances of it. The decorators work with TypeScript's standard decorators and with `experimentalDecorators`, with no setting to change.

```ts
import { Attribute, Block, Config, Entity, Int, LocalRegistry, Meta, Sensitive } from "xcl-lang";

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

await using config = new Config({ registries: [local], statePath: ".xcl" });
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

## Printing errors

A configuration mistake comes back as a `ConfigError` holding the engine's report: the summary, where it is, the numbered source lines with the fault marked, and the detail. The report is the one Go prints, byte for byte.

```ts
import { forStream, formatError, printError } from "xcl-lang";

try {
  await config.apply("./infra");
} catch (err) {
  printError(err, { formatter: forStream(process.stderr) });
  const text = formatError(err); // the same report as a string
  process.exitCode = 1;
}
```

```text
Error: Unsupported block type

  on infra/main.xcl line 7, in resource.recording.two, field nope[0]:
     5 | 
     6 | resource "recording" "two" {
     7 |   nope {
     8 |     a = 1
     9 |   }

Blocks of type "nope" are not expected here.
```

`printError` writes to `process.stderr` unless `out` names another writer, and `formatError` returns what it would write. Output is plain text unless `formatter` asks for colour. Detail wraps at 80 columns; `width` chooses another width, and `0` or `null` turns wrapping off. Any other error prints its message, and any other value its text form, so printing never throws.

You see the report with no printing code at all:

- `console.error(err)` shows the report, in colour when Node's console colours that stream.
- An uncaught error, a thrown one or a rejected top-level `await`, shows the report as plain text. It is carried in the error's `stack`, between the first line and the frames, and the package installs no process listener.
- A JSON logger's standard error handling carries it: `problems` (each with `file`, `line`, `column`, `summary`, `detail`, `entity` and `field`) and `report` (the plain report) are enumerable, so pino's `err` serializer and winston's `format.errors()` log them with no configuration.

`err.message` stays one line, and `err.tokens` is the report as labelled text.

## Printing entities and change summaries

```ts
import { printDiff } from "xcl-lang";

await config.printEntity(await config.find("app.web"), { includeComputed: true });
printDiff(await config.diff("./infra"));
```

`printEntity` takes the same four encoding choices as `encodeEntity` (`includeComputed`, `includeEmpty`, `revealSensitive` and `showReferences`) and writes to `process.stdout`, as `printDiff` does. Both take `out`, `formatter` and `theme`, as errors do.

## Formats and themes

Every printed output is labelled text, which a format turns into plain text, terminal colour, HTML or SVG:

| Format | Writes |
|---|---|
| `plain` | the text, the default |
| `terminal` | the text in terminal colour |
| `html` | a `<pre class="xcl">` block with a class per kind, such as `xcl-attribute` |
| `htmlInline` | the same markup styled with `style` attributes, for places a stylesheet cannot reach |
| `svg` | a standalone image |

`forStream(stream)` picks `terminal` for a terminal when `NO_COLOR` is unset, and `plain` otherwise. The package never colours output unless you choose a colour format or ask for one chosen from the stream.

A theme gives a style string for each kind of text it changes; a kind it leaves out takes its category's style, then plain text's. Extend the default with a spread:

```ts
import { defaultTheme, Kind, loadVSCodeTheme, printError, terminal, validateTheme } from "xcl-lang";

const theme = { ...defaultTheme, [Kind.Attribute]: "bold #ff8800", [Kind.LineComment]: "italic bright-black" };
validateTheme(theme); // throws InvalidStyleError naming any word it does not recognise

printError(err, { formatter: terminal, theme });

const fromVSCode = { ...defaultTheme, ...(await loadVSCodeTheme("my-theme.json")) };
```

A style string holds `bold`, `italic`, `underline`, `dim`, a foreground colour (`#rrggbb` or a named colour such as `bright-red`) and `bg:#rrggbb`, separated by spaces. Printing with a word the theme check would report skips that word rather than failing.

## Stylesheets

`css(theme)` generates a stylesheet for the classes the `html` format writes, the same one Go generates. The package ships the default as `xcl-lang/xcl.css`, so a site can link or bundle it:

```ts
import { writeFileSync } from "node:fs";
import { css, defaultTheme, Kind } from "xcl-lang";

writeFileSync("xcl.css", css({ ...defaultTheme, [Kind.Attribute]: "#ff8800" }));
```

```css
@import "xcl-lang/xcl.css";
```

## Custom formats

A format is a function, given the whole labelled text at once, the theme, and the writer to write to. Use it anywhere a built-in format is accepted:

```ts
import { cssClassOf, type Formatter } from "xcl-lang";

const bracketed: Formatter = (out, _theme, tokens) => {
  for (const token of tokens) {
    out.write(token.kind === 0 ? token.text : `[${cssClassOf(token.kind)}:${token.text}]`);
  }
};

printError(err, { formatter: bracketed });
```

The labelled text itself is `err.tokens`, `await config.entityTokens(entity)` and `diff.tokens`. Each token carries its `kind`, a `Kind` or a number from a newer engine, and the tokens' texts join to the plain output.

## Logging

`events.toLogger` sends every event to a logger of your own, at the levels and with the messages Go's logging bridge uses, with the event's details as fields:

```ts
import pino from "pino";
import { Config, events } from "xcl-lang";

await using config = new Config({ onEvent: events.toLogger(pino()) });
// winston takes the message first:
// onEvent: events.toLogger(winstonLogger, { order: "message-first" })
```

A log event is written at its own level with its own message. Every other event is written as `<operation> <phase>`, at error for `error`, warn for `blocked` and info otherwise. The fields are `source`, `operation`, `phase`, `resource`, `type`, `file`, `duration` (milliseconds), `error`, then the event's details.

## Pretty logger

The pretty logger shows what xcl is doing, in one line of setup: each event a readable line, each created entity's configuration beneath its line, and each configuration mistake's report beneath its error.

```ts
import { Config, EventDataLevel, prettylog } from "xcl-lang";

await using config = new Config({
  onEvent: prettylog.handler({ level: prettylog.levelFromEnv() }),
  eventData: EventDataLevel.Processed, // puts each created entity on its event
});
```

```text
3:04PM INFO create success source=core operation=create phase=success resource=resource.recording.one type=recording.one duration=1.2ms
  resource "recording" "one" {
    value  = "a"
    output = "one-a" # set by the provider
  }
```

- `out` is the stream, by default `process.stderr`, and `level` is the minimum level, `"info"` when not chosen.
- `prettylog.levelFromEnv()` reads `XCL_LOG_LEVEL` (`debug`, `info`, `warn` or `error`, in any case; anything else means info). The variable is read only when you call it.
- Configuration appears at info and below. Above info only events at the level are written, though a configuration mistake's report still appears beneath its error line.
- Without `eventData: EventDataLevel.Processed`, one line says how to turn it on.
- An entity whose configuration cannot be shown gets one warning line, and variables, outputs and modules are skipped.
- Colour follows the stream, as `forStream` chooses it; `formatter` chooses another format.
- `{ logger }` routes the lines through a logger of your own instead of a stream, with `order` as for `events.toLogger`.
- A line and everything beneath it go out in one write, and nothing waits on the stream, so the logger never holds up or fails an operation.

## More

- Events, state stores and encryption: the `onEvent`, `eventData`, `stateStore` and `stateMask` options of `new Config({...})`.
- Errors are classes, one per kind, all `instanceof XclError`.
- [`PARITY.md`](PARITY.md) lists every Go operation and lookup with its TypeScript equivalent.

## Engine

One engine runs per process, and one per worker thread, started on first use and shared by every configuration there. An idle engine never keeps Node alive, and it exits when your program does, however your program ends. `XCL_CORE_PATH` runs a source build of the engine instead of the platform package.

Constructing a `Config` starts nothing. The configuration is created in the engine on its first call, which starts the engine if it is not running, checks its version and sends your registered types and functions, so a registration the engine refuses rejects that first call. To find out sooner, call `await config.setup()`: it does the same work and resolves to the configuration. Most programs never need it. It is there for a program that should fail at start-up, such as a service checking its configuration at boot, or that wants the engine's start-up cost paid before latency-sensitive work. Python's asyncio API calls the same thing `open()`.

The package has its own version, and bundles the xcl engine release pinned in `xcl-ref.txt` when it was built; `await engineVersion()` reports it, starting the engine if it is not running. The package refuses to run against any other engine: `engineVersion()` rejects with `EngineVersionError` for an engine of another version, and with `EngineNotFoundError` when there is none.

## Releases and the engine pin

Releases are automatic, and follow [xcl's release process](https://github.com/jumppad-labs/xcl#releases). Every pull request carries exactly one of the labels `patch`, `minor`, `major` or `no-release`, and merging it tags and publishes the next version of this package to npm, `xcl-lang` and its eight platform packages at the same version, with npm trusted publishing and provenance, and a GitHub release listing the merged pull requests and naming the bundled engine. The package's version line is its own: a fix here releases TypeScript alone, with no xcl release.

`xcl-ref.txt` pins the xcl release the package is tested against and bundles: each platform package carries that release's signed `xcl-core`. When xcl releases, a pull request titled "Use xcl engine <tag>" moves the pin to the new tag, labelled with the same size as the engine release. It merges by itself once its checks pass, which releases the package with the new engine. If its checks fail it stays open; fix the package on its branch and it merges once they pass.

A release stamps the pin into `src/version.ts` as `ENGINE_VERSION`, and the package's version as `PACKAGE_VERSION`. In a checkout `ENGINE_VERSION` holds the development value `v0.0.0-dev`, which `make engine` also stamps on the engine it builds, so a development engine always passes the version check.

## License

Apache-2.0
