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

`xcl.NewConfig(options...)` is `await createConfig({...})`, whose options are below.

## Configuration options

| Go (`xcl.NewConfig` option) | `createConfig({...})` |
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

## Printing and logging

Printing errors, resources and diffs, themes, formatters and the pretty logger belong to the next part of the TypeScript SDK, and are not in this release.

| Go | TypeScript |
|---|---|
| `xcl.PrintError`, `xcl.PrintDiff`, `xcl.ErrorTokens`, `(*diff.Diff).Tokens()` | planned |
| `PrintEntity`, `EntityTokens` | planned |
| `highlight.*`, `events.SlogHandler`, `example/prettylog` | planned |

## Not applicable

| Go | Why there is no TypeScript form |
|---|---|
| `Decode(entity, &target)` | A lookup already returns an instance of the registered class; there is no separate struct to fill. |
| `As[T](entity)` | `find(App, address)` is the conversion, and `entity.as(App)` converts a generic entity. |
| `GetResources()` / `ResourceCount()` | Deprecated in Go in favour of `Entities()` / `EntityCount()`. |
| `highlight.Tokenize(text)` | The package never lexes configuration: labelled text comes from the engine. |
