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
 * refuses rejects that first call. Call `setup()` to do that work earlier.
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
   */
  async setup(): Promise<this> {
    await this.#ensure();
    return this;
  }

  /** Checks the configuration at `paths` is valid, calling no provider. Rejects with `ConfigError`. */
  async validate(paths: Paths, options: OperationOptions = {}): Promise<void> {
    await this.#run("startValidate", () => ({ paths: pathsOf(paths) }), options.signal);
  }

  /** Applies the configuration at `paths`: creates, updates and destroys entities, then saves state. */
  async apply(paths: Paths, options: OperationOptions = {}): Promise<void> {
    await this.#run("startApply", () => ({ paths: pathsOf(paths) }), options.signal);
  }

  /** What applying the configuration at `paths` would do, without doing it. */
  async diff(paths: Paths, options: DiffOptions = {}): Promise<Diff> {
    const result = await this.#run("startDiff", () => ({ paths: pathsOf(paths), revealSensitive: options.revealSensitive ?? false }), options.signal);
    return result ?? Diff.fromJSON(new Uint8Array());
  }

  /** Reads the saved state into the configuration, so lookups answer from it. */
  async load(options: OperationOptions = {}): Promise<void> {
    await this.#run("startLoad", () => ({}), options.signal);
  }

  /** Destroys every entity in the saved state, children first, saving after each. */
  async destroy(options: OperationOptions = {}): Promise<void> {
    await this.#run("startDestroy", () => ({}), options.signal);
  }

  /** The entity at `address` as an instance of `type`, a class registered on this configuration. */
  find<T extends object>(type: EntityClass<T>, address: string): Promise<T>;
  /** The entity at `address`, as a generic `Entity`. Rejects with `NotFoundError` when there is none. */
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

  /** Every entity of the type the segments name, as instances of `type`. */
  findByType<T extends object>(type: EntityClass<T>, ...path: string[]): Promise<T[]>;
  /** Every entity of the type the segments name, such as `"database", "postgres"`, as generic entities. */
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

  /** The single entity of the type the segments name, as an instance of `type`. */
  findOne<T extends object>(type: EntityClass<T>, ...path: string[]): Promise<T>;
  /** The single entity of the type the segments name. Rejects with `NotFoundError` or `NotUniqueError`. */
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

  /** Every entity of `type`, a class registered on this configuration. */
  async all<T extends object>(type: EntityClass<T>): Promise<T[]> {
    const names = this.#classes.namesOf(type);
    return this.findByType(type, ...(names.subtype ? [names.type, names.subtype] : [names.type]));
  }

  /** Every entity the configuration holds: an instance of the registered class where there is one, a generic `Entity` otherwise. */
  async entities(): Promise<Array<object | Entity>> {
    const response = await this.#engine().call(await this.#ensure(), "entities", {});
    return response.entities.map((entity) => hydrate(parseRecord(entity), this.#classes));
  }

  /** How many entities the configuration holds. */
  async entityCount(): Promise<number> {
    const response = await this.#engine().call(await this.#ensure(), "entities", {});
    return response.entities.length;
  }

  /** The configuration's outputs as a plain object, keyed by address with the output's name in camelCase. */
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
   */
  async printEntity(entity: object, options: EncodeOptions & Omit<PrintOptions, "width"> = {}): Promise<void> {
    const tokens = await this.entityTokens(entity, options);
    (options.formatter ?? plain)(options.out ?? process.stdout, options.theme ?? defaultTheme, tokens);
  }

  /** An entity's configuration text as labelled text, the same text `encodeEntity` returns. Refused while an operation runs. */
  async entityTokens(entity: object, options: EncodeOptions = {}): Promise<Token[]> {
    const record = recordBytes(entity, this.#classes);
    const response = await this.#engine().call(await this.#ensure(), "encodeEntity", { entity: record, options: encodeOptions(options), tokens: true });
    return tokensFromProto(response.tokens);
  }

  /**
   * Releases the configuration in the engine. Every later call rejects with
   * `InvalidArgumentError`. Closing twice, or closing a configuration that was
   * never created in the engine, is harmless.
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

  /** Closes the configuration when an `await using` block ends. */
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
