/** A configuration: its operations and lookups. */

import { Diff } from "./diff.js";
import { CancelledError, InvalidArgumentError, OperationInProgressError } from "./errors.js";
import { releaseInterrupt } from "./interrupt.js";
import { ClassMap, GenericEntity, hydrate, outputKey, parseRecord, recordBytes, toSnake, typedEntity, type Entity } from "./hydrate.js";
import { Client } from "./internal/client.js";
import { Operation, type Handlers, type StateStore } from "./internal/poll.js";
import type { Mask } from "./mask.js";
import { sharedTransport } from "./internal/subprocess.js";
import type { Registry } from "./registry.js";
import type { EntityClass } from "./decorators.js";
import { eventDataLevelMessage, type Event, type EventDataLevel } from "./events.js";
import { plain } from "./highlight/formatters.js";
import { tokensFromProto, type Token } from "./highlight/kinds.js";
import { linkEvent, type EventLink } from "./internal/event-link.js";
import { defaultTheme } from "./highlight/theme.js";
import type { PrintOptions } from "./print.js";

/** What a configuration is created with. */
export interface ConfigOptions {
  /** Where the configuration's types and plugins come from, in order. */
  registries?: readonly Registry[];
  /** The directory state is kept in. */
  statePath?: string;
  /** A store written in TypeScript to keep state in, instead of `statePath`. */
  stateStore?: StateStore;
  /** How sensitive values are written in state; give `aes256gcm` to encrypt them. */
  stateMask?: Mask;
  /** How sensitive values are written in event data; left out, they are redacted. */
  eventMask?: Mask;
  /** Turns off the redaction of sensitive values in event data. */
  noEventMask?: boolean;
  /**
   * Receives the engine's events, one at a time and in order. A handler that
   * returns a Promise is awaited before the next event, and an operation does
   * not finish until every handler has.
   */
  onEvent?: (event: Event) => void | Promise<void>;
  /** What resource data events carry, by default none. */
  eventData?: EventDataLevel;
  /** How many events may wait for the handler; 0 is the default. */
  eventBufferSize?: number;
  /** Values for `variable.<name>` in configuration. Top-level names follow the name rule. */
  variables?: Readonly<Record<string, unknown>>;
}

/** The four choices of Go's encoder, all off by default. */
export interface EncodeOptions {
  /** Writes computed fields. */
  includeComputed?: boolean;
  /** Writes fields holding empty values. */
  includeEmpty?: boolean;
  /** Writes real sensitive values rather than the marker. */
  revealSensitive?: boolean;
  /** Writes references as written in configuration rather than their values. */
  showReferences?: boolean;
}

function encodeOptions(options: EncodeOptions): Required<EncodeOptions> {
  return {
    includeComputed: options.includeComputed ?? false,
    includeEmpty: options.includeEmpty ?? false,
    revealSensitive: options.revealSensitive ?? false,
    showReferences: options.showReferences ?? false,
  };
}

export type { StateStore };

/** One path or several. */
export type Paths = string | readonly string[];

/** What every operation takes. */
export interface OperationOptions {
  /**
   * Stops the operation when aborted: the engine stops, saves the state of
   * everything completed so far, and the Promise rejects with `CancelledError`,
   * whose `cause` is the signal's `reason`.
   */
  signal?: AbortSignal;
}

/** What `diff` takes. */
export interface DiffOptions extends OperationOptions {
  /** Shows sensitive values in the diff rather than the marker. */
  revealSensitive?: boolean;
}

function pathsOf(paths: Paths): string[] {
  const listed = typeof paths === "string" ? [paths] : [...paths];
  if (listed.length === 0) {
    throw new InvalidArgumentError("at least one path is required", { details: { argument: "paths" } });
  }
  return listed;
}

let sharedClient: Client | undefined;

/** The client every configuration uses unless it was made with `configWith`. @internal */
export function sharedEngineClient(): Client {
  sharedClient ??= new Client(sharedTransport());
  return sharedClient;
}

function variablesJson(variables: Readonly<Record<string, unknown>>): Uint8Array {
  const named = Object.fromEntries(Object.entries(variables).map(([name, value]) => [toSnake(name), value]));
  return new TextEncoder().encode(JSON.stringify(named));
}

function createRequest(options: ConfigOptions): Record<string, unknown> {
  return {
    registries: (options.registries ?? []).map((registry) => registry.toProto()),
    events: options.onEvent !== undefined,
    eventBufferSize: options.eventBufferSize ?? 0,
    eventData: eventDataLevelMessage(options.eventData ?? "none"),
    ...(options.statePath !== undefined ? { stateStore: { kind: { case: "path" as const, value: options.statePath } } } : {}),
    ...(options.stateStore !== undefined ? { stateStore: { kind: { case: "host" as const, value: true } } } : {}),
    ...(options.stateMask !== undefined ? { stateMask: options.stateMask.message } : {}),
    ...(options.eventMask !== undefined ? { eventMask: options.eventMask.message } : {}),
    noEventMask: options.noEventMask ?? false,
    ...(options.variables !== undefined && Object.keys(options.variables).length > 0 ? { variablesJson: variablesJson(options.variables) } : {}),
  };
}

// the client the next constructed configuration uses, set only for the
// duration of a synchronous `configWith` call
let clientForNext: Client | undefined;

/**
 * A configuration: its operations and lookups.
 *
 * Constructing one does no I/O. The configuration is created in the engine on
 * its first call, which starts the engine on first use, checks its version and
 * sends every registered type and function, so a registration the engine
 * refuses rejects that first call, with {@link TypeNameClashError},
 * {@link TypeFormError}, {@link InvalidTypeError},
 * {@link FunctionNameClashError} or {@link InvalidFunctionError} as
 * {@link Config.setup} describes. Call `setup()` to do that work earlier.
 * Close it with `await using` or `close()`.
 */
export class Config {
  #client: Client | undefined;
  #handle: bigint | undefined;
  #creating: Promise<bigint> | undefined;
  #closed = false;
  #running = false;
  readonly #request: Record<string, unknown>;
  readonly #classes: ClassMap;
  readonly #handlers: Handlers;

  /**
   * A configuration built from `options`, with nothing sent to the engine yet.
   * Throws for options that cannot work together: `InvalidArgumentError` for
   * `statePath` with `stateStore`, and `SchemaError` for one class registered
   * as two block types.
   *
   * @param options The registries, state, masks, event handling and variables the configuration is created with.
   * @throws {@link InvalidArgumentError} when `options` gives both `statePath` and `stateStore`.
   * @throws {@link SchemaError} when one class is registered as two block types across the registries.
   */
  constructor(options: ConfigOptions = {}) {
    if (options.statePath !== undefined && options.stateStore !== undefined) {
      throw new InvalidArgumentError("give statePath or stateStore, not both");
    }
    this.#client = clientForNext;
    const registries = options.registries ?? [];
    this.#classes = new ClassMap(registries.flatMap((registry) => registry.registrations));
    this.#request = createRequest(options);
    const functions = new Map(registries.flatMap((registry) => registry.functions).map((declared) => [declared.name, declared.call]));
    const handlers: Handlers = { functions, onEvent: options.onEvent, store: options.stateStore, classes: this.#classes };
    // each event remembers, privately, the configuration delivering it, so the
    // pretty logger can render its saved record with no configuration passed in
    const link: EventLink = { eventData: options.eventData ?? "none", savedEntityTokens: (record) => this.#savedEntityTokens(record) };
    const onEvent = handlers.onEvent;
    this.#handlers =
      onEvent === undefined
        ? handlers
        : {
            ...handlers,
            onEvent: (event: Event) => {
              linkEvent(event, link);
              return onEvent(event);
            },
          };
  }

  /**
   * Creates the configuration in the engine now rather than on its first
   * call, and resolves to it. Optional: every call does this itself.
   *
   * Use it to fail at start-up, for example a service checking its
   * configuration at boot, on a registration the engine refuses, a missing
   * engine or an engine of the wrong version; or to pay the engine's start-up
   * cost before latency-sensitive work. Calling it again does nothing more.
   * Python's asyncio API calls this `open()`.
   *
   * @returns A Promise that resolves to this configuration once it exists in the engine.
   * @throws {@link InvalidArgumentError} when the configuration is closed, or the engine refuses an option, such as a negative `eventBufferSize`.
   * @throws {@link EngineNotFoundError} when the engine cannot be found on first use.
   * @throws {@link EngineVersionError} when the engine's version differs from the one the package was built for.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link TypeNameClashError} when two registries, or a registry and a builtin, declare the same type.
   * @throws {@link TypeFormError} when a type is declared both with and without a subtype.
   * @throws {@link InvalidTypeError} when a registered type has a field configuration cannot be decoded into.
   * @throws {@link FunctionNameClashError} when a function name is offered twice, or is a builtin's.
   * @throws {@link InvalidFunctionError} when a registered function has a signature the engine cannot use.
   * @throws {@link MaskNotReversibleError} when `stateMask` cannot recover the values it masks.
   */
  async setup(): Promise<this> {
    await this.#ensure();
    return this;
  }

  /**
   * Checks the configuration at `paths` is valid, calling no provider.
   *
   * @param paths The files or directories the configuration is read from; at least one.
   * @param options Takes `signal`, which stops the validation only before it starts.
   * @throws {@link ConfigError} when the configuration is invalid; `problems` lists each problem.
   * @throws {@link InvalidArgumentError} when `paths` is empty, or the configuration is closed.
   * @throws {@link OperationInProgressError} when another operation is running on this configuration.
   * @throws {@link CancelledError} when `signal` is aborted before the validation starts.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link PluginNotFoundError} when a GitHub plugin's release does not exist or has no build for this platform.
   * @throws {@link PluginVerificationError} when a GitHub plugin's release fails its signature or checksum check.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async validate(paths: Paths, options: OperationOptions = {}): Promise<void> {
    await this.#run("startValidate", () => ({ paths: pathsOf(paths) }), options.signal);
  }

  /**
   * Applies the configuration at `paths`: creates, updates and destroys entities, then saves state.
   *
   * @param paths The files or directories the configuration is read from; at least one.
   * @param options Takes `signal`, which stops the apply and saves the progress made so far.
   * @throws {@link ConfigError} when the configuration is invalid; `problems` lists each problem.
   * @throws {@link EmptyConfigurationError} when `paths` hold no configuration; nothing is destroyed or saved.
   * @throws {@link ProviderError} when a provider fails during a lifecycle step; the progress made so far is saved.
   * @throws {@link InvalidArgumentError} when `paths` is empty, or the configuration is closed.
   * @throws {@link OperationInProgressError} when another operation is running on this configuration.
   * @throws {@link CancelledError} when `signal` is aborted; its `cause` is the signal's `reason`.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link PluginNotFoundError} when a GitHub plugin's release does not exist or has no build for this platform.
   * @throws {@link PluginVerificationError} when a GitHub plugin's release fails its signature or checksum check.
   * @throws {@link UnregisteredTypeError} when a saved record names a type this configuration does not declare.
   * @throws {@link InvalidSavedDataError} when a saved record cannot be read.
   * @throws {@link UnrecoverableError} when a masked value in the saved state cannot be turned back into its real value.
   * @throws {@link InternalError} when the `stateStore` given in the options fails.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async apply(paths: Paths, options: OperationOptions = {}): Promise<void> {
    await this.#run("startApply", () => ({ paths: pathsOf(paths) }), options.signal);
  }

  /**
   * What applying the configuration at `paths` would do, without doing it.
   *
   * @param paths The files or directories the configuration is read from; at least one.
   * @param options Takes `signal`, which stops the diff, and `revealSensitive`, which shows sensitive values.
   * @returns A Promise that resolves to the {@link Diff}: what an apply would create, update, replace or delete.
   * @throws {@link ConfigError} when the configuration is invalid; `problems` lists each problem.
   * @throws {@link EmptyConfigurationError} when `paths` hold no configuration.
   * @throws {@link ProviderError} when a provider fails while reading or comparing an entity.
   * @throws {@link InvalidArgumentError} when `paths` is empty, or the configuration is closed.
   * @throws {@link OperationInProgressError} when another operation is running on this configuration.
   * @throws {@link CancelledError} when `signal` is aborted; its `cause` is the signal's `reason`.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link PluginNotFoundError} when a GitHub plugin's release does not exist or has no build for this platform.
   * @throws {@link PluginVerificationError} when a GitHub plugin's release fails its signature or checksum check.
   * @throws {@link UnregisteredTypeError} when a saved record names a type this configuration does not declare.
   * @throws {@link InvalidSavedDataError} when a saved record cannot be read.
   * @throws {@link UnrecoverableError} when a masked value in the saved state cannot be turned back into its real value.
   * @throws {@link InternalError} when the `stateStore` given in the options fails.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async diff(paths: Paths, options: DiffOptions = {}): Promise<Diff> {
    const result = await this.#run("startDiff", () => ({ paths: pathsOf(paths), revealSensitive: options.revealSensitive ?? false }), options.signal);
    return result ?? Diff.fromJSON(new Uint8Array());
  }

  /**
   * Reads the saved state into the configuration, so lookups answer from it.
   *
   * @param options Takes `signal`, which stops the load only before the state is read.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when another operation is running on this configuration.
   * @throws {@link CancelledError} when `signal` is aborted before the state is read.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link PluginNotFoundError} when a GitHub plugin's release does not exist or has no build for this platform.
   * @throws {@link PluginVerificationError} when a GitHub plugin's release fails its signature or checksum check.
   * @throws {@link UnregisteredTypeError} when a saved record names a type this configuration does not declare.
   * @throws {@link InvalidSavedDataError} when a saved record cannot be read.
   * @throws {@link UnrecoverableError} when a masked value in the saved state cannot be turned back into its real value.
   * @throws {@link InternalError} when the `stateStore` given in the options fails.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async load(options: OperationOptions = {}): Promise<void> {
    await this.#run("startLoad", () => ({}), options.signal);
  }

  /**
   * Destroys every entity in the saved state, children first, saving after each.
   *
   * @param options Takes `signal`, which stops the destroy; what was not reached stays in the state.
   * @throws {@link ProviderError} when a provider fails to destroy an entity; it stays in the state for the next destroy to retry.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when another operation is running on this configuration.
   * @throws {@link CancelledError} when `signal` is aborted; its `cause` is the signal's `reason`.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link PluginNotFoundError} when a GitHub plugin's release does not exist or has no build for this platform.
   * @throws {@link PluginVerificationError} when a GitHub plugin's release fails its signature or checksum check.
   * @throws {@link UnregisteredTypeError} when a saved record names a type this configuration does not declare.
   * @throws {@link InvalidSavedDataError} when a saved record cannot be read.
   * @throws {@link UnrecoverableError} when a masked value in the saved state cannot be turned back into its real value.
   * @throws {@link InternalError} when the `stateStore` given in the options fails.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async destroy(options: OperationOptions = {}): Promise<void> {
    await this.#run("startDestroy", () => ({}), options.signal);
  }

  /**
   * The entity at `address` as an instance of `type`, a class registered on this configuration.
   *
   * @param type The registered class to return the entity as.
   * @param address The entity's address, such as `"app.web"`.
   * @returns A Promise that resolves to the entity as an instance of `type`.
   * @throws {@link NotFoundError} when no entity exists at `address`.
   * @throws {@link NotRegisteredError} when `type` is not registered on this configuration.
   * @throws {@link TypeMismatchError} when the entity at `address` is not of `type`.
   * @throws {@link InvalidArgumentError} when `address` is empty, or the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  find<T extends object>(type: EntityClass<T>, address: string): Promise<T>;
  /**
   * The entity at `address`, as a generic `Entity`.
   *
   * @param address The entity's address, such as `"app.web"`.
   * @returns A Promise that resolves to the entity as a generic {@link Entity}.
   * @throws {@link NotFoundError} when no entity exists at `address`.
   * @throws {@link InvalidArgumentError} when `address` is empty, or the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  find(address: string): Promise<Entity>;
  async find(first: EntityClass | string, address?: string): Promise<object> {
    const type = typeof first === "function" ? first : undefined;
    const target = typeof first === "function" ? (address as string) : first;
    if (type !== undefined) {
      this.#classes.namesOf(type);
    }
    const response = await this.#engine().call(await this.#ensure(), "find", { address: target });
    return this.#result(response.entity, type);
  }

  /**
   * Every entity of the type the segments name, as instances of `type`.
   *
   * @param type The registered class to return each entity as.
   * @param path The segments naming the type: the type, then its subtype where it takes one.
   * @returns A Promise that resolves to every matching entity as an instance of `type`; empty when none matches.
   * @throws {@link NotRegisteredError} when `type` is not registered on this configuration.
   * @throws {@link UnknownTypeError} when the leading segment names no type.
   * @throws {@link NotTypeableError} when the segments span more than one type, such as a type given without its subtype.
   * @throws {@link TypeMismatchError} when an entity found is not of `type`.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  findByType<T extends object>(type: EntityClass<T>, ...path: string[]): Promise<T[]>;
  /**
   * Every entity of the type the segments name, such as `"database", "postgres"`, as generic entities.
   *
   * @param path The segments naming the type: the type, then its subtype where it takes one.
   * @returns A Promise that resolves to every matching entity as a generic {@link Entity}; empty when none matches.
   * @throws {@link UnknownTypeError} when the leading segment names no type.
   * @throws {@link NotTypeableError} when the segments span more than one type, such as a type given without its subtype.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  findByType(...path: string[]): Promise<Entity[]>;
  async findByType(first: EntityClass | string, ...rest: string[]): Promise<object[]> {
    const type = typeof first === "function" ? first : undefined;
    const path = typeof first === "function" ? rest : [first, ...rest];
    if (type !== undefined) {
      this.#classes.namesOf(type);
    }
    const response = await this.#engine().call(await this.#ensure(), "findByType", { path });
    return response.entities.map((entity) => this.#result(entity, type));
  }

  /**
   * The single entity of the type the segments name, as an instance of `type`.
   *
   * @param type The registered class to return the entity as.
   * @param path The segments naming the type: the type, then its subtype where it takes one.
   * @returns A Promise that resolves to the one matching entity as an instance of `type`.
   * @throws {@link NotFoundError} when no entity matches.
   * @throws {@link NotUniqueError} when more than one entity matches; `details.count` says how many.
   * @throws {@link NotRegisteredError} when `type` is not registered on this configuration.
   * @throws {@link UnknownTypeError} when the leading segment names no type.
   * @throws {@link NotTypeableError} when the segments span more than one type, such as a type given without its subtype.
   * @throws {@link TypeMismatchError} when the entity found is not of `type`.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  findOne<T extends object>(type: EntityClass<T>, ...path: string[]): Promise<T>;
  /**
   * The single entity of the type the segments name.
   *
   * @param path The segments naming the type: the type, then its subtype where it takes one.
   * @returns A Promise that resolves to the one matching entity as a generic {@link Entity}.
   * @throws {@link NotFoundError} when no entity matches.
   * @throws {@link NotUniqueError} when more than one entity matches; `details.count` says how many.
   * @throws {@link UnknownTypeError} when the leading segment names no type.
   * @throws {@link NotTypeableError} when the segments span more than one type, such as a type given without its subtype.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  findOne(...path: string[]): Promise<Entity>;
  async findOne(first: EntityClass | string, ...rest: string[]): Promise<object> {
    const type = typeof first === "function" ? first : undefined;
    const path = typeof first === "function" ? rest : [first, ...rest];
    if (type !== undefined) {
      this.#classes.namesOf(type);
    }
    const response = await this.#engine().call(await this.#ensure(), "findOne", { path });
    return this.#result(response.entity, type);
  }

  /**
   * Every entity of `type`, a class registered on this configuration.
   *
   * @param type The registered class whose entities to return.
   * @returns A Promise that resolves to every entity of `type`; empty when there is none.
   * @throws {@link NotRegisteredError} when `type` is not registered on this configuration.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async all<T extends object>(type: EntityClass<T>): Promise<T[]> {
    const names = this.#classes.namesOf(type);
    return this.findByType(type, ...(names.subtype ? [names.type, names.subtype] : [names.type]));
  }

  /**
   * Every entity the configuration holds: an instance of the registered class where there is one, a generic `Entity` otherwise.
   *
   * @returns A Promise that resolves to every entity; empty before an apply or a load.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async entities(): Promise<Array<object | Entity>> {
    const response = await this.#engine().call(await this.#ensure(), "entities", {});
    return response.entities.map((entity) => hydrate(parseRecord(entity), this.#classes));
  }

  /**
   * How many entities the configuration holds.
   *
   * @returns A Promise that resolves to the number of entities.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async entityCount(): Promise<number> {
    const response = await this.#engine().call(await this.#ensure(), "entities", {});
    return response.entities.length;
  }

  /**
   * The configuration's outputs as a plain object, keyed by address with the output's name in camelCase.
   *
   * @returns A Promise that resolves to each output's value by its key; empty when there are none.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async outputs(): Promise<Record<string, unknown>> {
    const response = await this.#engine().call(await this.#ensure(), "outputs", {});
    if (response.outputsJson.length === 0) {
      return {};
    }
    const outputs = JSON.parse(new TextDecoder().decode(response.outputsJson)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(outputs).map(([address, value]) => [outputKey(address), value]));
  }

  /**
   * An entity rendered as configuration text: a looked-up or hand-built
   * instance, or a generic entity. The engine renders it, so it is Go's text.
   * Refused while an operation runs.
   *
   * @param entity The entity: an instance of a registered class, or a generic {@link Entity}.
   * @param options The four encoding choices, all off by default.
   * @returns A Promise that resolves to the configuration text.
   * @throws {@link NotEncodableError} when `entity` is not an entity, has no name, is a builtin, or holds a value with no configuration form.
   * @throws {@link NotRegisteredError} when `entity`'s class is not registered on this configuration.
   * @throws {@link UnregisteredTypeError} when the entity names a type this configuration does not declare.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async encodeEntity(entity: unknown, options: EncodeOptions = {}): Promise<string> {
    const record = recordBytes(entity, this.#classes);
    const response = await this.#engine().call(await this.#ensure(), "encodeEntity", { entity: record, options: encodeOptions(options) });
    return new TextDecoder().decode(response.text);
  }

  /**
   * A saved record rendered as configuration text, as a state store holds it
   * and events carry it. Allowed at any time, including from an `onEvent`
   * handler while an operation runs.
   *
   * @param record One entity's saved JSON, as bytes or a string.
   * @param options The four encoding choices, all off by default.
   * @returns A Promise that resolves to the configuration text.
   * @throws {@link InvalidSavedDataError} when `record` is not one saved entity record.
   * @throws {@link UnregisteredTypeError} when `record` names a type this configuration does not declare.
   * @throws {@link NotEncodableError} when the entity has no form as configuration text, such as a builtin.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link InvalidArgumentError} when `record` is empty, or the configuration is closed.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async encodeSavedEntity(record: Uint8Array | string, options: EncodeOptions = {}): Promise<string> {
    const entity = typeof record === "string" ? new TextEncoder().encode(record) : record;
    const response = await this.#engine().call(await this.#ensure(), "encodeSavedEntity", { entity, options: encodeOptions(options) });
    return new TextDecoder().decode(response.text);
  }

  /**
   * Prints an entity as configuration text, in one call, to `process.stdout` by
   * default, as Go's `xcl.PrintEntity` prints it, with the same four encoding
   * choices as `encodeEntity`. The output is plain text unless `formatter`
   * chooses another format. Refused while an operation runs.
   *
   * @param entity The entity: an instance of a registered class, or a generic {@link Entity}.
   * @param options The four encoding choices, and the writer, format and theme to print with.
   * @throws {@link NotEncodableError} when `entity` is not an entity, has no name, is a builtin, or holds a value with no configuration form.
   * @throws {@link NotRegisteredError} when `entity`'s class is not registered on this configuration.
   * @throws {@link UnregisteredTypeError} when the entity names a type this configuration does not declare.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async printEntity(entity: object, options: EncodeOptions & Omit<PrintOptions, "width"> = {}): Promise<void> {
    const tokens = await this.entityTokens(entity, options);
    (options.formatter ?? plain)(options.out ?? process.stdout, options.theme ?? defaultTheme, tokens);
  }

  /**
   * An entity's configuration text as labelled text, the same text `encodeEntity` returns. Refused while an operation runs.
   *
   * @param entity The entity: an instance of a registered class, or a generic {@link Entity}.
   * @param options The four encoding choices, all off by default.
   * @returns A Promise that resolves to the text as {@link Token}s, each labelled with its kind.
   * @throws {@link NotEncodableError} when `entity` is not an entity, has no name, is a builtin, or holds a value with no configuration form.
   * @throws {@link NotRegisteredError} when `entity`'s class is not registered on this configuration.
   * @throws {@link UnregisteredTypeError} when the entity names a type this configuration does not declare.
   * @throws {@link PluginLoadError} when a registered plugin cannot be started or read.
   * @throws {@link InvalidArgumentError} when the configuration is closed.
   * @throws {@link OperationInProgressError} when an operation is running on this configuration.
   * @throws {@link EngineExitedError} when the engine stops during the call.
   * @throws {@link XclError} any error {@link Config.setup} rejects with, when this call creates the configuration in the engine.
   */
  async entityTokens(entity: object, options: EncodeOptions = {}): Promise<Token[]> {
    const record = recordBytes(entity, this.#classes);
    const response = await this.#engine().call(await this.#ensure(), "encodeEntity", { entity: record, options: encodeOptions(options), tokens: true });
    return tokensFromProto(response.tokens);
  }

  /**
   * Releases the configuration in the engine. Every later call rejects with
   * `InvalidArgumentError`. Closing twice, or closing a configuration that was
   * never created in the engine, is harmless.
   *
   * @throws {@link InternalBindingError} when the engine refuses to release the configuration, which is a bug in this package.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const creating = this.#creating;
    if (creating !== undefined) {
      // a creation still in flight finishes first, so its handle is released
      await creating.catch(() => undefined);
    }
    const handle = this.#handle;
    if (handle !== undefined) {
      this.#handle = undefined;
      await this.#engine().release(handle);
    }
  }

  /**
   * Closes the configuration when an `await using` block ends.
   *
   * @throws {@link InternalBindingError} when the engine refuses to release the configuration, which is a bug in this package.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** A saved record as labelled text with its computed values, as the pretty logger shows it; allowed during an operation. */
  async #savedEntityTokens(record: Uint8Array): Promise<Token[]> {
    const response = await this.#engine().call(await this.#ensure(), "encodeSavedEntity", { entity: record, options: encodeOptions({ includeComputed: true }), tokens: true });
    return tokensFromProto(response.tokens);
  }

  #result(data: Uint8Array, type: EntityClass | undefined): object {
    const record = parseRecord(data);
    return type === undefined ? new GenericEntity(record, this.#classes) : typedEntity(record, type, this.#classes);
  }

  #engine(): Client {
    this.#client ??= sharedEngineClient();
    return this.#client;
  }

  /**
   * The configuration's handle, creating it in the engine on the first call.
   * Concurrent first calls share one creation; a failed creation is not
   * remembered, so the next call tries again, on a fresh engine if the last
   * one exited.
   */
  #ensure(): Promise<bigint> {
    if (this.#closed) {
      return Promise.reject(new InvalidArgumentError("the configuration is closed"));
    }
    if (this.#handle !== undefined) {
      return Promise.resolve(this.#handle);
    }
    this.#creating ??= this.#create().then(
      (handle) => {
        this.#creating = undefined;
        return handle;
      },
      (error: unknown) => {
        this.#creating = undefined;
        throw error;
      },
    );
    return this.#creating;
  }

  async #create(): Promise<bigint> {
    const response = await this.#engine().call(0n, "createConfig", this.#request as never);
    this.#handle = response.handle;
    return response.handle;
  }

  async #run(method: "startValidate" | "startApply" | "startDiff" | "startLoad" | "startDestroy", buildRequest: () => Record<string, unknown>, signal: AbortSignal | undefined): Promise<Diff | undefined> {
    try {
      const request = buildRequest();
      if (this.#closed) {
        throw new InvalidArgumentError("the configuration is closed");
      }
      if (this.#running) {
        throw new OperationInProgressError("another operation is running on this configuration; operations on one configuration run one at a time");
      }
      if (signal?.aborted) {
        throw new CancelledError("the operation was not started: its signal was already aborted", { cause: signal.reason });
      }

      this.#running = true;
      try {
        const handle = await this.#ensure();
        if (signal?.aborted) {
          throw new CancelledError("the operation was not started: its signal was aborted while the configuration was being created", { cause: signal.reason });
        }
        const client = this.#engine();
        const started = await client.call(handle, method, request as never);
        return await new Operation(client, handle, started.operationId, this.#handlers).drive(signal);
      } finally {
        this.#running = false;
      }
    } finally {
      releaseInterrupt(signal);
    }
  }
}

/** A configuration over a client of the caller's, such as a fake transport's. @internal */
export function configWith(client: Client, options: ConfigOptions = {}): Config {
  clientForNext = client;
  try {
    return new Config(options);
  } finally {
    clientForNext = undefined;
  }
}
