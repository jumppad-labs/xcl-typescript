import { create, toBinary, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";

import { ErrorSchema, GetVersionResponseSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { STATUS_ERROR, STATUS_OK, type CallResult, type Transport } from "../../src/internal/transport.js";
import { ENGINE_VERSION } from "../../src/version.js";

/** One call the fake received. */
export interface RecordedCall {
  handle: bigint;
  method: string;
  request: Uint8Array;
}

type Answer = (call: RecordedCall) => CallResult | Promise<CallResult>;

/** The answer for a successful call. */
export function ok<D extends DescMessage>(schema: D, init?: MessageInitShape<D>): CallResult {
  return { status: STATUS_OK, payload: toBinary(schema, create(schema, init)) };
}

/** The answer for a call the engine failed with an `Error` message. */
export function failed(code: string, message: string): CallResult {
  return { status: STATUS_ERROR, payload: toBinary(ErrorSchema, create(ErrorSchema, { code, message })) };
}

/** A scripted transport: each method answers as its test says, and every call is recorded. */
export class FakeTransport implements Transport {
  readonly calls: RecordedCall[] = [];
  readonly released: bigint[] = [];
  closed = 0;
  releaseStatus = STATUS_OK;
  private readonly answers = new Map<string, Answer[]>();

  constructor(engineVersion = ENGINE_VERSION, abiVersion = 1) {
    this.always("GetVersion", () => ok(GetVersionResponseSchema, { version: engineVersion, abiVersion }));
  }

  /** Answers every call of `method` with `answer`. */
  always(method: string, answer: Answer): this {
    this.answers.set(method, [answer]);
    return this;
  }

  /** Answers the next calls of `method`, in order, the last repeating. */
  queue(method: string, ...answers: Answer[]): this {
    this.answers.set(method, answers);
    return this;
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async call(handle: bigint, method: string, request: Uint8Array): Promise<CallResult> {
    const call = { handle, method, request };
    this.calls.push(call);
    const answers = this.answers.get(method);
    if (answers === undefined || answers.length === 0) {
      throw new Error(`the fake transport has no answer for ${method}`);
    }
    const answer = (answers.length > 1 ? answers.shift() : answers[0]) as Answer;
    return answer(call);
  }

  async release(handle: bigint): Promise<number> {
    this.released.push(handle);
    return this.releaseStatus;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}
