/**
 * The errors the package throws.
 *
 * Every application error the engine reports crosses as one `Error` message
 * with a stable code, a message for people, details by name and the causes it
 * collects. `fromProto` turns it into the class registered for its code, so a
 * program catches `NotFoundError` rather than inspecting a code. An unknown
 * code becomes the base `XclError`, so it can still be caught.
 *
 * `SchemaError` and the `Engine*` errors are raised by the package itself,
 * never by the engine.
 */

import { inspect } from "node:util";

import { terminal } from "./highlight/formatters.js";
import { goName, tokensFromProto, type Token } from "./highlight/kinds.js";
import { defaultTheme } from "./highlight/theme.js";
import type { Error as ErrorMessage } from "./internal/core/xcl/core/v1/core_pb.js";
import { plainReport, render } from "./internal/render.js";

/** One problem in configuration, positioned where it was found. */
export interface Problem {
  /** The file the problem is in. */
  readonly file: string;
  /** The line it starts on, or 0 when it has no position. */
  readonly line: number;
  /** The column it starts at, or 0 when it has no position. */
  readonly column: number;
  /** What is wrong. */
  readonly summary: string;
  /** Why it is wrong, or an empty string. */
  readonly detail: string;
  /** The block the problem is in, when the engine knows it. */
  readonly entity: string;
  /** The field within the block, when the engine knows it. */
  readonly field: string;
}

/** What an error can be built with beside its message. */
export interface XclErrorOptions {
  /** The stable code; a subclass supplies its own. */
  code?: string;
  /** The fields of the engine's detail type, by name. */
  details?: Readonly<Record<string, string>>;
  /** The errors this one collects, in order. */
  causes?: readonly XclError[];
  /** What led to this error, as on a standard `Error`. */
  cause?: unknown;
}

/**
 * Every error the package throws. `code` is the stable code a subclass is
 * registered for, and `code`, `message`, `details` and `problems` are all
 * enumerable, so a structured logger records them with no configuration.
 */
export class XclError extends Error {
  /** The code this class is registered for. */
  static readonly code: string = "internal";

  /** The stable code of this error. */
  readonly code: string;
  /** The fields of the engine's detail type, by name. */
  readonly details: Readonly<Record<string, string>>;
  /** The errors this one collects, in order. */
  readonly causes: readonly XclError[];
  /** Every positioned configuration problem the error holds, in order. */
  readonly problems: readonly Problem[];
  /** The engine's report as labelled text; empty for an error holding no report. Not enumerable, since nothing but printing wants it. */
  declare readonly tokens: readonly Token[];
  /** The report as plain text, wrapped at 80 columns; present only on an error holding a report. */
  declare readonly report?: string;

  constructor(message: string, options: XclErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? (new.target as typeof XclError).code;
    this.details = { ...options.details };
    this.causes = [...(options.causes ?? [])];
    this.problems = problemsOf(this);
    // a standard Error's message is an own property that is not enumerable
    Object.defineProperty(this, "message", { value: message, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(this, "tokens", { value: [], enumerable: false, writable: true, configurable: true });
  }

  /**
   * How `console.error` and `util.inspect` show the error: its stack, which
   * holds the report, with the report in terminal colour when Node's `colors`
   * option asks for it. An error holding no report shows as Node shows any
   * error. An uncaught error never reaches this: Node's fatal path turns custom
   * inspection off, which is why the plain report is also in `stack`.
   */
  [inspect.custom](_depth: number, options: { colors?: boolean }): unknown {
    if (this.tokens.length === 0) {
      return this;
    }
    const stack = this.stack ?? "";
    if (options.colors !== true || this.report === undefined) {
      return stack;
    }
    const coloured = render(this.tokens, terminal, defaultTheme, 80).replace(/\n+$/, "");
    // the report starts after the first line, which may hold the same text
    const start = stack.indexOf(this.report, stack.indexOf("\n") + 1);
    return start === -1 ? stack : stack.slice(0, start) + coloured + stack.slice(start + this.report.length);
  }
}

/** No entity exists at the address asked for; `details.address` names it. */
export class NotFoundError extends XclError {
  static override readonly code: string = "not_found";
}

/** More than one entity matched a lookup that expects one; `details.count` says how many. */
export class NotUniqueError extends XclError {
  static override readonly code: string = "not_unique";
}

/** A lookup named a type nothing declares; `details.name` is the segment. */
export class UnknownTypeError extends XclError {
  static override readonly code: string = "unknown_type";
}

/** A lookup's segments span more than one type, such as a type given without its subtype. */
export class NotTypeableError extends XclError {
  static override readonly code: string = "not_typeable";
}

/** A type was asked for that no registry on this configuration declares. */
export class NotRegisteredError extends XclError {
  static override readonly code: string = "not_registered";
}

/** An entity was found but is not of the type asked for. */
export class TypeMismatchError extends XclError {
  static override readonly code: string = "type_mismatch";
}

/** A lookup named something that is not a declaration of its own, such as a nested block. */
export class NotAnEntityError extends XclError {
  static override readonly code: string = "not_an_entity";
}

/** Two registries, or a registry and a builtin, declare the same type. */
export class TypeNameClashError extends XclError {
  static override readonly code: string = "type_name_clash";
}

/** A type was declared both with and without a subtype. */
export class TypeFormError extends XclError {
  static override readonly code: string = "type_form";
}

/** A declared type has a field configuration cannot be decoded into. */
export class InvalidTypeError extends XclError {
  static override readonly code: string = "invalid_type";
}

/** A function name is offered twice; `details` name both sources and their registries. */
export class FunctionNameClashError extends XclError {
  static override readonly code: string = "function_name_clash";
}

/** A function offered to configuration has a signature the engine cannot use. */
export class InvalidFunctionError extends XclError {
  static override readonly code: string = "invalid_function";
}

/** A plugin could not be started or read. */
export class PluginLoadError extends XclError {
  static override readonly code: string = "plugin_load";
}

/** A plugin was not found where it was looked for. */
export class PluginNotFoundError extends XclError {
  static override readonly code: string = "plugin_not_found";
}

/** A plugin release failed its signature or checksum check. */
export class PluginVerificationError extends XclError {
  static override readonly code: string = "plugin_verification";
}

/** The paths given held no configuration. */
export class EmptyConfigurationError extends XclError {
  static override readonly code: string = "empty_configuration";
}

/** A saved record names a type this configuration does not declare. */
export class UnregisteredTypeError extends XclError {
  static override readonly code: string = "unregistered_type";
}

/** A saved record could not be read. */
export class InvalidSavedDataError extends XclError {
  static override readonly code: string = "invalid_saved_data";
}

/** A value has no form as configuration text. */
export class NotEncodableError extends XclError {
  static override readonly code: string = "not_encodable";
}

/** The state could not be recovered. */
export class UnrecoverableError extends XclError {
  static override readonly code: string = "unrecoverable";
}

/** A mask that cannot be reversed was used where a value must be read back. */
export class MaskNotReversibleError extends XclError {
  static override readonly code: string = "mask_not_reversible";
}

/** A colour theme could not be used; `details.source` names it. */
export class InvalidThemeError extends XclError {
  static override readonly code: string = "invalid_theme";
}

/** The configuration is invalid; `problems` lists each problem with its file and line. */
export class ConfigError extends XclError {
  static override readonly code: string = "config";
}

/** A provider failed during a lifecycle step; `details.address` and `details.step` say where. */
export class ProviderError extends XclError {
  static override readonly code: string = "provider";
}

/** The operation was stopped before it reached every entity; the progress made was saved. */
export class CancelledError extends XclError {
  static override readonly code: string = "cancelled";
}

/** A call was refused because an operation is running on the configuration. */
export class OperationInProgressError extends XclError {
  static override readonly code: string = "operation_in_progress";
}

/** A request parsed but made no sense, such as an operation with no paths. */
export class InvalidArgumentError extends XclError {
  static override readonly code: string = "invalid_argument";
}

/** An error the engine could not classify. */
export class InternalError extends XclError {
  static override readonly code: string = "internal";
}

/** A class or function cannot be registered; the message names the class and field. */
export class SchemaError extends XclError {
  static override readonly code: string = "schema";
}

/** The engine package for this platform is not installed. */
export class EngineNotFoundError extends XclError {
  static override readonly code: string = "engine_not_found";

  /** The package expected for this platform, or an empty string for an `XCL_CORE_PATH` that does not exist. */
  readonly packageName: string;

  constructor(message: string, packageName = "") {
    super(message, { details: packageName ? { package: packageName } : {} });
    this.packageName = packageName;
  }
}

/** The engine's version is not the one this package was built for. */
export class EngineVersionError extends XclError {
  static override readonly code: string = "engine_version";

  /** The version the package was built for. */
  readonly expected: string;
  /** The version the engine reports. */
  readonly engine: string;

  constructor(message: string, expected: string, engine: string) {
    super(message, { details: { expected, engine } });
    this.expected = expected;
    this.engine = engine;
  }
}

/**
 * The engine stopped while this package was using it. Every call waiting on
 * it throws this, and the next call that needs the engine starts a fresh one.
 */
export class EngineExitedError extends XclError {
  static override readonly code: string = "engine_exited";

  /** The engine's exit status, or null when a signal ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the engine, or null when it exited by itself. */
  readonly signal: string | null;

  constructor(exitCode: number | null, signal: string | null) {
    const how = signal !== null ? `it was ended by signal ${signal}` : exitCode !== null ? `it exited with status ${exitCode}` : "its pipe closed";
    const details: Record<string, string> = {};
    if (signal !== null) {
      details.signal = signal;
    }
    if (exitCode !== null) {
      details.status = String(exitCode);
    }
    super(`the xcl engine stopped unexpectedly: ${how}. Configurations created before it stopped are gone; the next configuration starts a new engine`, { details });
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** One style word a style does not understand. */
export interface InvalidStyleWord {
  /** The kind whose style holds the word. */
  readonly kind: number;
  /** The whole style string. */
  readonly style: string;
  /** The word. */
  readonly word: string;
}

function goQuote(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * A theme holds style words a style does not understand; `words` names each
 * one, in the order of the kinds and then of the words. It is thrown by
 * `validateTheme`, never by the engine. Printing with such a theme still works:
 * the words are skipped.
 */
export class InvalidStyleError extends XclError {
  static override readonly code: string = "invalid_style";

  /** Each unknown word, with the kind and style holding it. */
  readonly words: readonly InvalidStyleWord[];

  constructor(words: readonly InvalidStyleWord[]) {
    super(words.map(({ kind, style, word }) => `style ${goQuote(style)} for ${goName(kind)}: unknown word ${goQuote(word)}`).join("; "), {
      details: { words: words.map(({ word }) => word).join(" ") },
    });
    this.words = [...words];
  }
}

const STATUS_REASONS: Readonly<Record<number, string>> = {
  [-1]: "unknown method",
  [-2]: "the request did not parse",
  [-3]: "unknown or released handle",
  [-4]: "handle given where none is taken, or missing where one is needed",
};

/** The engine refused a call with a negative status, which is a bug in this package. */
export class InternalBindingError extends XclError {
  static override readonly code: string = "internal_binding";

  /** The method that was refused. */
  readonly method: string;
  /** The status the engine answered with. */
  readonly status: number;

  constructor(method: string, status: number) {
    super(`the engine refused ${method} with status ${status} (${STATUS_REASONS[status] ?? "unknown status"}); this is a bug in the xcl-lang package`, {
      details: { method, status: String(status) },
    });
    this.method = method;
    this.status = status;
  }
}

const BY_CODE: ReadonlyMap<string, new (message: string, options?: XclErrorOptions) => XclError> = new Map(
  [
    NotFoundError,
    NotUniqueError,
    UnknownTypeError,
    NotTypeableError,
    NotRegisteredError,
    TypeMismatchError,
    NotAnEntityError,
    TypeNameClashError,
    TypeFormError,
    InvalidTypeError,
    FunctionNameClashError,
    InvalidFunctionError,
    PluginLoadError,
    PluginNotFoundError,
    PluginVerificationError,
    EmptyConfigurationError,
    UnregisteredTypeError,
    InvalidSavedDataError,
    NotEncodableError,
    UnrecoverableError,
    MaskNotReversibleError,
    InvalidThemeError,
    ConfigError,
    ProviderError,
    CancelledError,
    OperationInProgressError,
    InvalidArgumentError,
    InternalError,
  ].map((type) => [type.code, type]),
);

/** Turns an `Error` message from the engine into the error class for its code. */
export function fromProto(error: ErrorMessage): XclError {
  const causes = error.causes.map(fromProto);
  const known = BY_CODE.get(error.code);
  const message = oneLine(error.message);
  const built = known === undefined ? new XclError(message, { code: error.code, details: error.details, causes }) : new known(message, { details: error.details, causes });
  attachReport(built, tokensFromProto(error.report));
  return built;
}

/** A message on one line: Go's `ConfigError` text has one line per problem, which a log wants as one. */
function oneLine(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("; ");
}

/**
 * Puts a report on an error built from the engine's message. It runs once the
 * error exists, so the first line of `stack` carries the subclass's name, which
 * V8 captures from the constructor before the name is set.
 */
function attachReport(error: XclError, tokens: readonly Token[]): void {
  if (tokens.length === 0) {
    return;
  }
  const report = plainReport(tokens);
  Object.defineProperty(error, "tokens", { value: tokens, enumerable: false, writable: true, configurable: true });
  // An own enumerable accessor rather than a data property: JSON.stringify,
  // Object.assign, pino's err serializer and winston's format.errors() all copy
  // it, while Node's uncaught-error output shows [Getter] instead of printing
  // the report a second time as an escaped, quoted string.
  Object.defineProperty(error, "report", { get: () => report, enumerable: true, configurable: true });
  const stack = error.stack ?? "";
  const frames = stack.indexOf("\n    at ");
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  error.stack = `${header}\n${report}${frames === -1 ? "" : stack.slice(frames)}`;
}

function problemsOf(error: XclError): Problem[] {
  const found = error.causes.filter((cause) => (cause.code === "config" || cause.code === "provider") && "file" in cause.details).map(problemOf);
  if (found.length === 0 && "file" in error.details) {
    found.push(problemOf(error));
  }
  return found;
}

function problemOf(error: XclError): Problem {
  const details = error.details;
  return {
    file: details.file ?? "",
    line: integer(details.line),
    column: integer(details.column),
    summary: details.summary || error.message,
    detail: details.detail ?? "",
    entity: details.entity ?? "",
    field: details.field ?? "",
  };
}

function integer(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
