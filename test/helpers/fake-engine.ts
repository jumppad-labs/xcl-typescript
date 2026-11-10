/**
 * A stand-in for the engine program, speaking the frame protocol over its
 * standard input and output.
 *
 * The subprocess transport's unit tests launch the compiled file with
 * `process.execPath`; nothing imports it. Each frame is a 4-byte big-endian
 * length followed by a `Request` (read from stdin) or a `Response` (written to
 * stdout) of `transport.proto`. Requests are handled on the event loop, so a
 * delayed request never holds up a quick one and responses can arrive out of
 * order.
 *
 * Methods it understands:
 *
 * - `GetVersion`: `GetVersionResponse` with `version` from `FAKE_VERSION`
 *   (default `v0.0.0-fake`) and `abi_version` from `FAKE_ABI` (default 1).
 * - `CreateConfig`: `CreateConfigResponse` with the next handle, from 1.
 * - `Release`: status 0 for a handle it issued, -3 otherwise.
 * - `Echo`: the payload is JSON; it creates the file named by `started_file`
 *   when given, waits `delay_ms` and answers with the same payload.
 * - `Status`: the payload is an ascii integer, answered as the status.
 * - `Exit`: exits at once with the ascii integer code in the payload.
 * - `Kill`: sends itself SIGKILL.
 *
 * Any other method answers status -1. When `FAKE_STDERR` is set, its value is
 * written to standard error as a line at start up. The program exits 0 when
 * its input ends.
 */

import { writeFileSync } from "node:fs";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { CreateConfigResponseSchema, GetVersionResponseSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { RequestSchema, ResponseSchema, type Request } from "../../src/internal/core/xcl/core/v1/transport_pb.js";

const FRAME_HEADER_SIZE = 4;
const STATUS_OK = 0;
const STATUS_UNKNOWN_METHOD = -1;
const STATUS_UNKNOWN_HANDLE = -3;

const issuedHandles = new Set<bigint>();
let nextHandle = 1n;

/** Writes a `Response`, its signed status as the two's-complement uint32 the message carries. */
function respond(id: bigint, status: number, payload: Uint8Array): void {
  const body = toBinary(ResponseSchema, create(ResponseSchema, { id, status: status >>> 0, payload }));
  const header = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function asciiInteger(payload: Uint8Array): number {
  return Number.parseInt(Buffer.from(payload).toString("ascii") || "0", 10);
}

function echo(request: Request): void {
  const text = Buffer.from(request.payload).toString("utf8");
  const options = JSON.parse(text === "" ? "{}" : text) as { started_file?: string; delay_ms?: number };
  if (options.started_file) {
    writeFileSync(options.started_file, "");
  }
  setTimeout(() => {
    respond(request.id, STATUS_OK, request.payload);
  }, options.delay_ms ?? 0);
}

function handleRequest(request: Request): void {
  switch (request.method) {
    case "GetVersion": {
      const answer = create(GetVersionResponseSchema, {
        version: process.env.FAKE_VERSION ?? "v0.0.0-fake",
        abiVersion: Number.parseInt(process.env.FAKE_ABI ?? "1", 10),
      });
      respond(request.id, STATUS_OK, toBinary(GetVersionResponseSchema, answer));
      return;
    }
    case "CreateConfig": {
      const handle = nextHandle;
      nextHandle += 1n;
      issuedHandles.add(handle);
      respond(request.id, STATUS_OK, toBinary(CreateConfigResponseSchema, create(CreateConfigResponseSchema, { handle })));
      return;
    }
    case "Release": {
      const known = issuedHandles.delete(request.handle);
      respond(request.id, known ? STATUS_OK : STATUS_UNKNOWN_HANDLE, new Uint8Array());
      return;
    }
    case "Echo":
      echo(request);
      return;
    case "Status":
      respond(request.id, asciiInteger(request.payload), new Uint8Array());
      return;
    case "Exit":
      process.exit(asciiInteger(request.payload));
      return;
    case "Kill":
      process.kill(process.pid, "SIGKILL");
      return;
    default:
      respond(request.id, STATUS_UNKNOWN_METHOD, new Uint8Array());
  }
}

if (process.env.FAKE_STDERR) {
  process.stderr.write(`${process.env.FAKE_STDERR}\n`);
}

let unread: Buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  unread = Buffer.concat([unread, chunk]);
  while (unread.length >= FRAME_HEADER_SIZE) {
    const frameEnd = FRAME_HEADER_SIZE + unread.readUInt32BE(0);
    if (unread.length < frameEnd) {
      return;
    }
    const body = unread.subarray(FRAME_HEADER_SIZE, frameEnd);
    unread = unread.subarray(frameEnd);
    handleRequest(fromBinary(RequestSchema, body));
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
