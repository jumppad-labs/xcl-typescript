export { Config } from "./config.js";
export type { ConfigOptions, DiffOptions, EncodeOptions, OperationOptions, Paths, StateStore } from "./config.js";
export { Diff, UNKNOWN } from "./diff.js";
export type { Change, Dependency, ResourceDiff, Summary } from "./diff.js";
export { engineVersion } from "./engine-version.js";
export * from "./errors.js";
export { Event, EventDataLevel } from "./events.js";
export type { LevelLogger, ToLoggerOptions } from "./events.js";
/** Events: the `Event` class, event data levels, and `toLogger`, which sends events to a logger of your own. */
export * as events from "./events.js";
export { Any, Attribute, Block, Blocks, Computed, Func, Int, Label, NamedBlocks } from "./decorators.js";
export type { ClassDecorator, EntityClass, FieldDecorator, FieldOptions, FuncOptions, MethodDecorator, TypeSpec } from "./decorators.js";
export { Entity, Meta } from "./entity.js";
export { Sensitive } from "./sensitive.js";
export type { SensitiveFunction, SensitiveOptions } from "./sensitive.js";
export { interruptSignal } from "./interrupt.js";
/** Masks for sensitive values in state and events: `aes256gcm`, `hmacSha256`, `redact` and `omit`. */
export * as mask from "./mask.js";
export type { Mask } from "./mask.js";
export { GitHubRegistry, LocalRegistry } from "./registry.js";
export type { GitHubRegistryOptions, LocalRegistryOptions, Registry } from "./registry.js";
export { Kind, cssClassOf, parentOf } from "./highlight/kinds.js";
export type { Token } from "./highlight/kinds.js";
export { parseStyle } from "./highlight/style.js";
export type { Style } from "./highlight/style.js";
export { defaultTheme, styleFor } from "./highlight/theme.js";
export type { Theme } from "./highlight/theme.js";
export { validateTheme } from "./highlight/validate.js";
export { html, htmlInline, plain, svg, terminal } from "./highlight/formatters.js";
export type { Formatter, Writer } from "./highlight/formatters.js";
export { css } from "./highlight/css.js";
export { forStream } from "./highlight/stream.js";
export { loadVSCodeTheme } from "./highlight/vscode.js";
export { formatError, printDiff, printError } from "./print.js";
export type { FormatOptions, PrintOptions } from "./print.js";
/** The pretty logger: `prettylog.handler` writes every event as a readable line, and `prettylog.levelFromEnv` reads `XCL_LOG_LEVEL`. */
export * as prettylog from "./prettylog.js";
