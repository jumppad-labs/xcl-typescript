/**
 * The poll loop: one operation, driven from `Start*` to `OperationFinished`.
 *
 * An operation runs inside the engine. Everything it needs from the program
 * arrives as a task through `Poll`, and its end as the finished task.
 */

import type { MessageInitShape, MessageShape } from "@bufbuild/protobuf";

import { Diff } from "../diff.js";
import { Event } from "../events.js";
import type { ClassMap } from "../hydrate.js";
import { CancelledError, fromProto, InvalidArgumentError } from "../errors.js";
import { isSensitive } from "../sensitive.js";
import type { Client } from "./client.js";
import { StateTask_Kind, type FunctionTaskSchema, type OperationFinishedSchema, type StateResultSchema, type StateTaskSchema } from "./core/xcl/core/v1/core_pb.js";

/** How long one `Poll` may wait in the engine for a task, in milliseconds. */
export const POLL_WAIT_MS = 1000;

/**
 * A state store written in TypeScript. Each method may return a Promise. Each
 * record is one entity's JSON, as in Go and Python, with real sensitive values
 * unless a state mask is set.
 */
export interface StateStore {
  /** Returns the saved records. */
  load(): Uint8Array[] | Promise<Uint8Array[]>;
  /** Saves every record of the state. */
  save(records: Uint8Array[]): void | Promise<void>;
  /** Whether anything has been saved. */
  exists(): boolean | Promise<boolean>;
  /** Removes everything saved. */
  clear(): void | Promise<void>;
}

/** What an operation answers tasks with. */
export interface Handlers {
  functions: ReadonlyMap<string, (...args: unknown[]) => unknown>;
  onEvent?: ((event: Event) => void | Promise<void>) | undefined;
  store?: StateStore | undefined;
  classes: ClassMap;
}

/** One operation in the engine, polled through the client. */
export class Operation {
  private finished: MessageShape<typeof OperationFinishedSchema> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private cancelled = false;
  private failure: unknown;
  // events are delivered one at a time, in order: each waits for the last
  private events: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly handle: bigint,
    readonly id: bigint,
    private readonly handlers: Handlers,
  ) {}

  /**
   * Runs the operation to its end and returns its result: the diff of a diff,
   * undefined otherwise. Aborting `signal` sends `Cancel` at once, without
   * waiting for a poll to return, and the loop runs on to the finished task.
   */
  async drive(signal?: AbortSignal): Promise<Diff | undefined> {
    const onAbort = (): void => {
      this.cancel();
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this.run(signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private cancel(): void {
    this.cancelled = true;
    this.client.call(this.handle, "cancel", { operationId: this.id }).catch(() => {
      // the operation has already ended, or the engine has gone, which the poll loop reports
    });
  }

  private async run(signal: AbortSignal | undefined): Promise<Diff | undefined> {
    while (this.finished === undefined) {
      const response = await this.client.call(this.handle, "poll", { waitMs: POLL_WAIT_MS });
      if (response.task.case === "finished") {
        this.finished = response.task.value;
      } else if (response.task.case === "function") {
        this.track(this.answerFunction(response.task.value));
      } else if (response.task.case === "state") {
        this.track(this.answerState(response.task.value));
      } else if (response.task.case === "event") {
        this.deliver(new Event(response.task.value, this.handlers.classes));
      }
    }

    // after a cancel nothing waits for the program's own promises: a stuck
    // handler or task must not hold up the rejection
    if (!this.cancelled) {
      await Promise.all(this.pending);
      await this.events;
      if (this.failure !== undefined) {
        throw this.failure;
      }
    }

    if (this.finished.error !== undefined) {
      const error = fromProto(this.finished.error);
      if (error instanceof CancelledError && signal?.aborted) {
        Object.defineProperty(error, "cause", { value: signal.reason, enumerable: false, writable: true, configurable: true });
      }
      throw error;
    }
    return this.finished.diffJson.length > 0 ? Diff.fromJSON(this.finished.diffJson) : undefined;
  }

  /** Queues an event for the handler. A handler's exception is reported as a warning and affects nothing else. */
  private deliver(event: Event): void {
    const onEvent = this.handlers.onEvent;
    if (onEvent === undefined) {
      return;
    }
    this.events = this.events.then(async () => {
      try {
        await onEvent(event);
      } catch (error) {
        process.emitWarning(`an xcl onEvent handler failed: ${error instanceof Error ? error.message : String(error)}`, "XclEventHandlerWarning");
      }
    });
  }

  /** Runs one task beside the loop, so a slow one holds up nothing. */
  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => {
        this.failure ??= error;
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }

  private async answerState(task: MessageShape<typeof StateTaskSchema>): Promise<void> {
    await this.complete(task.taskId, { case: "state", value: await this.callStore(task) });
  }

  private async callStore(task: MessageShape<typeof StateTaskSchema>): Promise<MessageInitShape<typeof StateResultSchema>> {
    try {
      const store = this.handlers.store;
      if (store === undefined) {
        throw new Error("the engine asked the host for state, but no state store was given");
      }
      switch (task.kind) {
        case StateTask_Kind.LOAD:
          return { entities: await store.load() };
        case StateTask_Kind.SAVE:
          await store.save(task.entities);
          return {};
        case StateTask_Kind.EXISTS:
          return { exists: await store.exists() };
        case StateTask_Kind.CLEAR:
          await store.clear();
          return {};
        default:
          throw new Error(`unknown state task kind ${String(task.kind)}`);
      }
    } catch (error) {
      return { error: { code: "state_store", message: error instanceof Error && error.message ? error.message : String(error) } };
    }
  }

  private async answerFunction(task: MessageShape<typeof FunctionTaskSchema>): Promise<void> {
    await this.complete(task.taskId, { case: "function", value: await this.callFunction(task) });
  }

  private async callFunction(task: MessageShape<typeof FunctionTaskSchema>): Promise<{ result?: Uint8Array; error?: { code: string; message: string } }> {
    try {
      const call = this.handlers.functions.get(task.name);
      if (call === undefined) {
        throw new Error(`no TypeScript function is registered as ${task.name}`);
      }
      const args = task.args.length > 0 ? (JSON.parse(new TextDecoder().decode(task.args)) as unknown[]) : [];
      const value: unknown = await call(...args);
      return { result: new TextEncoder().encode(JSON.stringify((isSensitive(value) ? value.reveal() : value) ?? null)) };
    } catch (error) {
      return { error: { code: "function", message: error instanceof Error && error.message ? error.message : String(error) } };
    }
  }

  /** Answers a task. An operation that ended before the answer no longer waits for it, which is harmless. */
  private async complete(
    taskId: bigint,
    result: { case: "function"; value: { result?: Uint8Array; error?: { code: string; message: string } } } | { case: "state"; value: MessageInitShape<typeof StateResultSchema> },
  ): Promise<void> {
    try {
      await this.client.call(this.handle, "complete", { taskId, result });
    } catch (error) {
      if (!(error instanceof InvalidArgumentError)) {
        throw error;
      }
    }
  }
}
