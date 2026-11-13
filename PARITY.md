# Parity with the Go API

Every operation and lookup of the Go API has an equivalent here. This list is checked against the Go API of the xcl release the package bundles at each release, and the parity suite in `test/parity` checks that the two give the same results on a shared set of fixtures.

## Operations

Every operation returns a Promise and takes an optional `signal`.

| Go (`*xcl.Config`) | TypeScript |
|---|---|
| `Validate(paths...)` / `ValidateContext(ctx, paths...)` | `await config.validate(paths, { signal })` |
| `Apply(paths...)` / `ApplyContext(ctx, paths...)` | `await config.apply(paths, { signal })` |
| `Diff(paths, options...)` / `DiffContext(ctx, paths, options...)` | `await config.diff(paths, { signal, revealSensitive })` |
| `Destroy()` / `DestroyContext(ctx)` | `await config.destroy({ signal })` |
| `Load()` / `LoadContext(ctx)` | `await config.load({ signal })` |

`paths` is a string or an array of strings. The context forms are how an operation is cancelled: aborting the `AbortSignal` cancels the engine's context, and `interruptSignal()` does so on Ctrl-C for one operation.

## Lookups

| Go | TypeScript |
|---|---|
| `Entities()` | `await config.entities()` |
| `EntityCount()` | `await config.entityCount()` |
| `Find[T](c, address)` | `await config.find(App, address)` |
| `FindResource(address)` | `await config.find(address)` |
| `FindByType[T](c, path...)` | `await config.findByType(App, ...path)` |
| `FindEntitiesByType(path...)` | `await config.findByType(...path)` |
| `FindOne[T](c, path...)` | `await config.findOne(App, ...path)` |
| `FindOneEntity(path...)` | `await config.findOne(...path)` |
| `All[T](c)` | `await config.all(App)` |
| `Outputs()` | `await config.outputs()` |
| `EncodeEntity(value, options...)`, `(*Config).EncodeEntityRecord(record, options...)` | `await config.encodeEntity(entity, options)`, where a generic entity crosses as its record |
| `EncodeSavedEntity(data, options...)` | `await config.encodeSavedEntity(record, options)` |

With a class the result is an instance of it; without one it is a generic `Entity`, which is how a Go plugin's entities are read. `entities()` returns an instance of the registered class where there is one and a generic `Entity` otherwise. A class the configuration did not register throws `NotRegisteredError`, as `All[T]` with an unregistered `T` returns `ErrNotRegistered` in Go.

The encoding options are all off by default: `IncludeComputed()` is `includeComputed`, `IncludeEmpty()` is `includeEmpty`, `RevealSensitive()` is `revealSensitive` and `ShowReferences()` is `showReferences`. The engine renders the text through the same encoder Go uses, so it is identical to Go's for the same entity and choices, which the parity suite checks for every fixture.

`xcl.NewConfig(options...)` is `new Config({...})`, whose options are below. Constructing it does no I/O: the configuration is created in the engine on its first call, where Go creates it in `NewConfig`. `await config.setup()` does that work early, for a program that wants to fail at start-up; Python's asyncio API calls it `open()`.

## Configuration options

| Go (`xcl.NewConfig` option) | `new Config({...})` |
|---|---|
| `WithRegistry(r)` | `registries: [...]` |
| `WithStatePath(dir)` | `statePath` |
| `WithStateStore(store)` | `stateStore` |
| `WithStateMask(m)` | `stateMask: mask.aes256gcm(key)` |
| `WithVariables(vars)` | `variables` |
| `WithEventHandler(h)` | `onEvent` |
| `WithEventData(level)` | `eventData: EventDataLevel.None`, `.Raw` or `.Processed` |
| `WithEventBufferSize(n)` | `eventBufferSize` |
| `WithEventMask(m)` | `eventMask` |
| `WithNoEventMask()` | `noEventMask` |

## Registries

| Go | TypeScript |
|---|---|
| `registry.NewLocal(registry.PluginPattern(p))` | `new LocalRegistry({ pluginPattern })` |
| `registry.Register[T](local, type, subtype)` | `@Entity(type, subtype)` and `local.register(App)` |
| A label field, `xcl:"name,label"` | `@Label()` |
| A `Meta` field, `types.Meta` | `@Meta()` |
| A plain struct with neither, a singleton | a class with neither, a singleton |
| `local.RegisterFunction(name, fn)` | `@Func(params, result, { name })` and `local.registerFunctions(instance)` |
| `local.RegisterExternalPlugin(path)` / `(program, args...)` | `local.registerExternalPlugin(path)` / `([program, ...args])` |
| `local.RegisterPluginDirectory(dir)` | `local.registerPluginDirectory(dir)` |
| `registry.NewGitHub(options...)` | `new GitHubRegistry({ cacheDir, trustedKeys, token, apiUrl })` |
| `github.RegisterPlugin(repo, version)` | `github.registerPlugin(repo, version)` |
| `registry.Register[T](github, type, subtype)` | `github.register(App)` |

## Values

| Go | TypeScript |
|---|---|
| `types.Sensitive[T]` | `Sensitive<T>` |
| `diff.Diff`, `diff.Resource`, `diff.Change`, `diff.Summary` | `Diff`, `ResourceDiff`, `Change`, `Summary` |
| An unknown value in a diff | `UNKNOWN` |
| `events.Event` | `Event`, with `event.entity(App)` |
| `mask.EncryptAES256GCM`, `HashHMACSHA256`, `Redact`, `Omit` | `mask.aes256gcm`, `hmacSha256`, `redact`, `omit` |
| Sentinel errors and error types of `xcl/errors` | one class per code, each `instanceof XclError` |

## Printing

The engine lays out reports, configuration text and change summaries as labelled text, the same tokens Go's formatters receive, and the built-in formats write the same bytes as Go's. The parity suite compares printed reports, entities and change summaries for every fixture, and the formats and stylesheet are held to the reference outputs in xcl's `highlight/testdata/reference`.

| Go | TypeScript |
|---|---|
| `xcl.PrintError(w, err, options...)` | `printError(err, { out, formatter, theme, width })`; `formatError(err, {...})` for a string |
| `xcl.PrintEntity(w, entity, options...)` | `await config.printEntity(entity, { out, formatter, theme, includeComputed, ... })` |
| `xcl.PrintDiff(w, d, options...)` | `printDiff(diff, { out, formatter, theme })` |
| `xcl.PrintOption`, `xcl.WithFormatter(f)`, `xcl.WithTheme(t)`, `xcl.WithWidth(n)` | the options object, `PrintOptions` and `FormatOptions`, with `formatter`, `theme` and `width`; a `width` of `0` or `null` never wraps |
| `xcl.ErrorTokens(err)` | `err.tokens` |
| `xcl.EntityTokens(entity, options...)` | `await config.entityTokens(entity, options)` |
| `(*diff.Diff).Tokens()` | `diff.tokens`, on a diff `config.diff` returned |
| `%+v` on a configuration error | `err.report`, the plain report; `console.error(err)` and an uncaught error show it |
| `highlight.Plain`, `Terminal`, `HTML`, `HTMLInline`, `SVG` | `plain`, `terminal`, `html`, `htmlInline`, `svg` |
| `highlight.Formatter`, `highlight.FormatterFunc` | `Formatter`, a function `(out, theme, tokens) => void` writing to a `Writer` |
| `highlight.Kind`, `highlight.Token` | `Kind` (a numeric enum, the same numbers and names), `Token` |
| `highlight.Kinds()` | the `Kind` enum's numeric members, in numeric order: `Object.values(Kind).filter((kind) => typeof kind === "number")` |
| `Kind.Parent()`, `Kind.Class()` | `parentOf(kind)`, `cssClassOf(kind)`, for any number |
| `Kind.String()` | `Kind[kind]`, the enum's own reverse mapping, such as `"BlockType"`; undefined for a number this package does not know |
| `highlight.Theme`, `highlight.DefaultTheme` | `Theme` (a style string by kind), `defaultTheme` (frozen) |
| `DefaultTheme.With(overrides)` | `{ ...defaultTheme, [Kind.Attribute]: "#ff8800" }` |
| `Theme.Style(kind)`, `highlight.ParseStyle(s)` | `styleFor(theme, kind)`, `parseStyle(s)` |
| `highlight.Style`, `Style.IsZero()` | `Style`, a plain object of `bold`, `italic`, `underline`, `dim`, `foreground` and `background`; a style that sets nothing equals `parseStyle("")` |
| `highlight.Colour` | the `foreground` and `background` strings of a `Style`: a named colour such as `"bright-red"`, or `"#rrggbb"` |
| `Theme.Validate()` and `errors.InvalidStyleError` | `validateTheme(theme)`, throwing one `InvalidStyleError` naming every unknown word in `words` |
| `highlight.WriteCSS(w, theme)` | `css(theme)`; the default ships as `xcl-lang/xcl.css` |
| `highlight.For(w)` | `forStream(stream)` |
| `highlight.LoadVSCodeTheme(r)` and `errors.InvalidThemeError` | `await loadVSCodeTheme(pathOrBytes)`, converted by the engine, and `InvalidThemeError` |

## Logging

| Go | TypeScript |
|---|---|
| `events.SlogHandler(logger)` | `events.toLogger(logger, { order })`: the same levels, messages and field names, for any logger with `debug`, `info`, `warn` and `error`; fields first, as pino takes them, or `order: "message-first"`, as winston takes them |
| zap's `errorVerbose` from `%+v` | the enumerable `problems` and `report`, which pino's `err` serializer and winston's `format.errors()` carry with no configuration |

Go's pretty logger is an example (`example/prettylog`) that only its examples import; this package's is part of `xcl-lang`. The parity suite compares what the two write for every fixture whose apply succeeds, apart from times and durations.

| Go (`example/prettylog`) | TypeScript (`prettylog`) |
|---|---|
| `prettylog.Handler(w, level)` | `prettylog.handler({ out, level, logger, order, formatter })`: the same lines, and also a configuration mistake's report beneath its error line at every level, and one line saying how to turn entity data on when it is off |
| `prettylog.LevelFromEnv()` | `prettylog.levelFromEnv()`, `"debug"`, `"info"`, `"warn"` or `"error"` |
| `prettylog.LevelEnv` | `prettylog.LEVEL_ENV` (`"XCL_LOG_LEVEL"`) |
| `slog.Level` | `LogLevel`, one of the four level names |

## Engine version

A Go program compiles the engine in, so Go has no accessor for its version. This package runs the engine it bundles, the xcl release pinned in `xcl-ref.txt`, and `await engineVersion()` reports that engine's version, as Python's `xcl.engine_version()` does. It starts the engine if it is not running, and rejects with `EngineVersionError` for an engine of another version and `EngineNotFoundError` when there is none.

## Not applicable

| Go | Why there is no TypeScript form |
|---|---|
| `Decode(entity, &target)` | A lookup already returns an instance of the registered class; there is no separate struct to fill. |
| `As[T](entity)` | `find(App, address)` is the conversion, and `entity.as(App)` converts a generic entity. |
| `GetResources()` / `ResourceCount()` | Deprecated in Go in favour of `Entities()` / `EntityCount()`. |
| `highlight.Tokenize(text)` | The package never lexes configuration: labelled text comes from the engine. |
| `Kind.Scope()` | Scopes are used only to convert a VS Code theme, which the engine does for `loadVSCodeTheme`. |
| `Colour.Hex()` | The formats write a named colour as hex through the fixed palette themselves; a theme names colours as strings and never needs the hex form. |
