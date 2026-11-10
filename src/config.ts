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

class ConfigImpl {
  #handle: bigint | undefined;
  #running = false;
  readonly #client: Client;
  readonly #classes: ClassMap;
  readonly #handlers: Handlers;

  constructor(client: Client, handle: bigint, classes: ClassMap, handlers: Handlers) {
    this.#client = client;
    this.#handle = handle;
    this.#classes = classes;
    this.#handlers = handlers;
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
    const response = await this.#client.call(this.#open(), "find", { address: target });
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
    const response = await this.#client.call(this.#open(), "findByType", { path });
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
    const response = await this.#client.call(this.#open(), "findOne", { path });
    return this.#result(response.entity, type);
  }

  /** Every entity of `type`, a class registered on this configuration. */
  async all<T extends object>(type: EntityClass<T>): Promise<T[]> {
    const names = this.#classes.namesOf(type);
    return this.findByType(type, ...(names.subtype ? [names.type, names.subtype] : [names.type]));
  }

  /** Every entity the configuration holds: an instance of the registered class where there is one, a generic `Entity` otherwise. */
  async entities(): Promise<Array<object | Entity>> {
    const response = await this.#client.call(this.#open(), "entities", {});
    return response.entities.map((entity) => hydrate(parseRecord(entity), this.#classes));
  }

  /** How many entities the configuration holds. */
  async entityCount(): Promise<number> {
    const response = await this.#client.call(this.#open(), "entities", {});
    return response.entities.length;
  }

  /** The configuration's outputs as a plain object, keyed by address with the output's name in camelCase. */
  async outputs(): Promise<Record<string, unknown>> {
    const response = await this.#client.call(this.#open(), "outputs", {});
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
    const response = await this.#client.call(this.#open(), "encodeEntity", { entity: record, options: encodeOptions(options) });
    return new TextDecoder().decode(response.text);
  }

  /**
   * A saved record rendered as configuration text, as a state store holds it
   * and events carry it. Allowed at any time, including from an `onEvent`
   * handler while an operation runs.
   */
  async encodeSavedEntity(record: Uint8Array | string, options: EncodeOptions = {}): Promise<string> {
    const entity = typeof record === "string" ? new TextEncoder().encode(record) : record;
    const response = await this.#client.call(this.#open(), "encodeSavedEntity", { entity, options: encodeOptions(options) });
    return new TextDecoder().decode(response.text);
  }

  /** Releases the configuration in the engine. Closing twice is harmless. */
  async close(): Promise<void> {
    const handle = this.#handle;
    if (handle !== undefined) {
      this.#handle = undefined;
      await this.#client.release(handle);
    }
  }

  /** Closes the configuration when an `await using` block ends. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #result(data: Uint8Array, type: EntityClass | undefined): object {
    const record = parseRecord(data);
    return type === undefined ? new GenericEntity(record, this.#classes) : typedEntity(record, type, this.#classes);
  }

  #open(): bigint {
    if (this.#handle === undefined) {
      throw new InvalidArgumentError("the configuration is closed");
    }
    return this.#handle;
  }

  async #run(method: "startValidate" | "startApply" | "startDiff" | "startLoad" | "startDestroy", buildRequest: () => Record<string, unknown>, signal: AbortSignal | undefined): Promise<Diff | undefined> {
    try {
      const request = buildRequest();
      const handle = this.#open();
      if (this.#running) {
        throw new OperationInProgressError("another operation is running on this configuration; operations on one configuration run one at a time");
      }
      if (signal?.aborted) {
        throw new CancelledError("the operation was not started: its signal was already aborted", { cause: signal.reason });
      }

      this.#running = true;
      try {
        const started = await this.#client.call(handle, method, request as never);
        return await new Operation(this.#client, handle, started.operationId, this.#handlers).drive(signal);
      } finally {
        this.#running = false;
      }
    } finally {
      releaseInterrupt(signal);
    }
  }
}

/** A configuration, created with `createConfig`. There is no constructor to call. */
export type Config = ConfigImpl;

let sharedClient: Client | undefined;

function variablesJson(variables: Readonly<Record<string, unknown>>): Uint8Array {
  const named = Object.fromEntries(Object.entries(variables).map(([name, value]) => [toSnake(name), value]));
  return new TextEncoder().encode(JSON.stringify(named));
}

/** `createConfig` over a client of the caller's. @internal */
export async function createConfigWith(client: Client, options: ConfigOptions): Promise<Config> {
  if (options.statePath !== undefined && options.stateStore !== undefined) {
    throw new InvalidArgumentError("give statePath or stateStore, not both");
  }
  const classes = new ClassMap((options.registries ?? []).flatMap((registry) => registry.registrations));
  const response = await client.call(0n, "createConfig", {
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
  });
  const functions = new Map((options.registries ?? []).flatMap((registry) => registry.functions).map((declared) => [declared.name, declared.call]));
  return new ConfigImpl(client, response.handle, classes, { functions, onEvent: options.onEvent, store: options.stateStore, classes });
}

/**
 * Creates a configuration. It starts the engine on first use, checks its
 * version and asks it to build the configuration, so a registration the engine
 * refuses fails here rather than on the first operation.
 */
export function createConfig(options: ConfigOptions = {}): Promise<Config> {
  sharedClient ??= new Client(sharedTransport());
  return createConfigWith(sharedClient, options);
}
