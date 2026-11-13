import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { EngineExitedError, EngineNotFoundError } from "../../src/errors.js";
import { CreateConfigResponseSchema, GetVersionResponseSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { RequestSchema, ResponseSchema, type Request } from "../../src/internal/core/xcl/core/v1/transport_pb.js";
import { detectLibc, locateEngine, platformPackage, sharedTransport, SubprocessTransport, type EngineSearch, type Launcher } from "../../src/internal/subprocess.js";
import { signedStatus } from "../../src/internal/transport.js";

const fakeEnginePath = fileURLToPath(new URL("../helpers/fake-engine.js", import.meta.url));
const NOTHING = new Uint8Array();

/** A long enough wait that the call is still outstanding when the engine goes. */
const ONE_MINUTE_MS = 60_000;

/** A launcher running the fake engine, and every child it has started. */
function fakeEngineLauncher(environment: Record<string, string> = {}): { launcher: Launcher; launches: ChildProcess[] } {
  const launches: ChildProcess[] = [];
  const launcher: Launcher = (_program, args, options) => {
    const child = spawn(process.execPath, [fakeEnginePath, ...args], { ...options, env: { ...process.env, ...environment } });
    launches.push(child);
    return child;
  };
  return { launcher, launches };
}

/** A process that behaves enough like a `ChildProcess` to drive the transport by hand and record what it does. */
class HandBuiltChild extends EventEmitter {
  pid: number | undefined = 4242;
  /** Every `ref` and `unref`, on the child and on both pipes, in order. */
  readonly references: string[] = [];
  /** Whether each of the three is referenced now. */
  readonly held = { child: true, stdin: true, stdout: true };
  /** Every signal sent to the child, in order. */
  readonly kills: string[] = [];
  /** Every request written to the child's stdin, in order. */
  readonly requests: Request[] = [];
  /** The length of each chunk the child's stdout delivered. */
  readonly deliveredChunks: number[] = [];
  readonly stdout = new PassThrough();
  readonly stdin: Writable;

  constructor(private readonly ignoresSigterm = false) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.requests.push(fromBinary(RequestSchema, chunk.subarray(4)));
        done();
      },
    });
    Object.assign(this.stdin, {
      ref: () => {
        this.references.push("stdin.ref");
        this.held.stdin = true;
      },
      unref: () => {
        this.references.push("stdin.unref");
        this.held.stdin = false;
      },
    });
    Object.assign(this.stdout, {
      ref: () => {
        this.references.push("stdout.ref");
        this.held.stdout = true;
      },
      unref: () => {
        this.references.push("stdout.unref");
        this.held.stdout = false;
      },
    });
    this.stdout.on("data", (chunk: Buffer) => {
      this.deliveredChunks.push(chunk.length);
    });
  }

  ref(): void {
    this.references.push("child.ref");
    this.held.child = true;
  }

  unref(): void {
    this.references.push("child.unref");
    this.held.child = false;
  }

  kill(signal: string): boolean {
    this.kills.push(signal);
    if (signal !== "SIGTERM" || !this.ignoresSigterm) {
      setImmediate(() => {
        this.emit("close", null, signal);
      });
    }
    return true;
  }

  /** Answers the request numbered `index` with one whole frame. */
  answer(index: number, status: number, payload: Uint8Array = NOTHING): void {
    this.stdout.write(responseFrame(this.requestAt(index).id, status, payload));
  }

  requestAt(index: number): Request {
    const request = this.requests[index];
    assert.ok(request !== undefined, `the child has no request ${index}`);
    return request;
  }
}

/** A launcher that hands out one hand-built child. */
function launcherOf(child: HandBuiltChild): Launcher {
  return () => child as unknown as ChildProcess;
}

function responseFrame(id: bigint, status: number, payload: Uint8Array = NOTHING): Buffer {
  const body = toBinary(ResponseSchema, create(ResponseSchema, { id, status: status >>> 0, payload }));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function createConfigPayload(handle: bigint): Uint8Array {
  return toBinary(CreateConfigResponseSchema, create(CreateConfigResponseSchema, { handle }));
}

function handleIn(payload: Uint8Array): bigint {
  return fromBinary(CreateConfigResponseSchema, payload).handle;
}

async function createConfig(transport: SubprocessTransport): Promise<bigint> {
  const result = await transport.call(0n, "CreateConfig", NOTHING);
  assert.equal(result.status, 0);
  return handleIn(result.payload);
}

function ascii(text: string): Uint8Array {
  return Buffer.from(text, "ascii");
}

function echoRequest(delayMs: number, tag = ""): Uint8Array {
  return Buffer.from(JSON.stringify({ delay_ms: delayMs, tag }), "utf8");
}

function tagOf(payload: Uint8Array): string {
  return (JSON.parse(Buffer.from(payload).toString("utf8")) as { tag: string }).tag;
}

function textOf(payload: Uint8Array): string {
  return Buffer.from(payload).toString("utf8");
}

/** Lets everything already queued on the event loop run, so stream chunks arrive one at a time. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid(transport: SubprocessTransport): number {
  const pid = transport.pid;
  assert.ok(pid !== undefined, "the transport has no running engine");
  return pid;
}

function rejectionOf(result: PromiseSettledResult<unknown>): unknown {
  assert.equal(result.status, "rejected");
  return (result as PromiseRejectedResult).reason;
}

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return assert.fail("expected the action to throw");
}

/** A search on 64-bit glibc Linux where every package is installed, changed by each test as it needs. */
function search(changes: Partial<EngineSearch> = {}): EngineSearch {
  return {
    env: {},
    platform: "linux",
    arch: "x64",
    libc: () => "gnu",
    resolvePackage: (packageName) => `/packages/${packageName}/package.json`,
    exists: () => true,
    ...changes,
  };
}

function notInstalled(): string {
  throw new Error("Cannot find module");
}

// framing

test("a frame split across several chunks decodes", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);
  let answered = false;
  void calling.then(() => {
    answered = true;
  });
  const frame = responseFrame(child.requestAt(0).id, 0, Buffer.from("split payload"));

  child.stdout.write(frame.subarray(0, 1));
  await nextTurn();
  child.stdout.write(frame.subarray(1, 4));
  await nextTurn();
  child.stdout.write(frame.subarray(4, 9));
  await nextTurn();
  assert.equal(answered, false);

  child.stdout.write(frame.subarray(9));
  const result = await calling;

  assert.deepEqual(child.deliveredChunks, [1, 3, 5, frame.length - 9]);
  assert.equal(textOf(result.payload), "split payload");
});

test("several frames joined in one chunk all decode", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const first = transport.call(0n, "Echo", NOTHING);
  const second = transport.call(0n, "Echo", NOTHING);
  const third = transport.call(0n, "Echo", NOTHING);

  child.stdout.write(
    Buffer.concat([
      responseFrame(child.requestAt(0).id, 0, Buffer.from("one")),
      responseFrame(child.requestAt(1).id, 0, Buffer.from("two")),
      responseFrame(child.requestAt(2).id, 0, Buffer.from("three")),
    ]),
  );

  assert.equal(textOf((await first).payload), "one");
  assert.equal(textOf((await second).payload), "two");
  assert.equal(textOf((await third).payload), "three");
  assert.equal(child.deliveredChunks.length, 1);
});

test("a chunk ending part way through the next frame keeps the rest for the next chunk", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const first = transport.call(0n, "Echo", NOTHING);
  const second = transport.call(0n, "Echo", NOTHING);
  const firstFrame = responseFrame(child.requestAt(0).id, 0, Buffer.from("one"));
  const secondFrame = responseFrame(child.requestAt(1).id, 0, Buffer.from("two"));

  child.stdout.write(Buffer.concat([firstFrame, secondFrame.subarray(0, 6)]));
  assert.equal(textOf((await first).payload), "one");

  child.stdout.write(secondFrame.subarray(6));
  assert.equal(textOf((await second).payload), "two");
});

test("a response for an id nobody is waiting on is ignored", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);

  child.stdout.write(responseFrame(9999n, 0, Buffer.from("nobody asked")));
  child.answer(0, 0, Buffer.from("the answer"));

  assert.equal(textOf((await calling).payload), "the answer");
});

test("a frame that does not parse ends the engine with SIGKILL and fails the waiting call", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);
  const garbage = Buffer.from([0, 0, 0, 1, 0xff]);
  child.stdout.write(garbage);

  await assert.rejects(calling, (error: unknown) => {
    assert.ok(error instanceof EngineExitedError);
    assert.equal(error.signal, "SIGKILL");
    return true;
  });
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

// responses and statuses through the fake engine

test("GetVersion answers with the engine's version and abi defaults", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(0n, "GetVersion", NOTHING);

  assert.equal(result.status, 0);
  const version = fromBinary(GetVersionResponseSchema, result.payload);
  assert.equal(version.version, "v0.0.0-fake");
  assert.equal(version.abiVersion, 1);
});

test("GetVersion answers with the version and abi the engine was started with", async (t) => {
  const { launcher } = fakeEngineLauncher({ FAKE_VERSION: "v9.9.9", FAKE_ABI: "42" });
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(0n, "GetVersion", NOTHING);

  const version = fromBinary(GetVersionResponseSchema, result.payload);
  assert.equal(version.version, "v9.9.9");
  assert.equal(version.abiVersion, 42);
});

test("out of order responses reach the right callers", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const finished: string[] = [];
  const slow = transport.call(0n, "Echo", echoRequest(300, "slow")).then((result) => {
    finished.push("slow");
    return result;
  });
  const middle = transport.call(0n, "Echo", echoRequest(150, "middle")).then((result) => {
    finished.push("middle");
    return result;
  });
  const quick = transport.call(0n, "Echo", echoRequest(0, "quick")).then((result) => {
    finished.push("quick");
    return result;
  });

  const [slowResult, middleResult, quickResult] = await Promise.all([slow, middle, quick]);

  assert.deepEqual(finished, ["quick", "middle", "slow"]);
  assert.equal(tagOf(slowResult.payload), "slow");
  assert.equal(tagOf(middleResult.payload), "middle");
  assert.equal(tagOf(quickResult.payload), "quick");
});

test("an unknown method answers status -1", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(0n, "NoSuchMethod", NOTHING);

  assert.equal(result.status, -1);
});

test("a status of -3 written as two's complement comes back signed", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(0n, "Status", ascii("-3"));

  assert.equal(result.status, -3);
});

test("the most negative status comes back signed", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(0n, "Status", ascii("-2147483648"));

  assert.equal(result.status, -2147483648);
});

test("a positive status comes back unchanged", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(0n, "Status", ascii("1"));

  assert.equal(result.status, 1);
});

test("signedStatus leaves zero alone", () => {
  assert.equal(signedStatus(0), 0);
});

test("signedStatus leaves the largest positive status alone", () => {
  assert.equal(signedStatus(2147483647), 2147483647);
});

test("signedStatus reads 0xFFFFFFFF as -1", () => {
  assert.equal(signedStatus(0xffffffff), -1);
});

test("signedStatus reads 0xFFFFFFFD as -3", () => {
  assert.equal(signedStatus(0xfffffffd), -3);
});

test("signedStatus reads 0x80000000 as the most negative status", () => {
  assert.equal(signedStatus(0x80000000), -2147483648);
});

// ref and unref

test("a newly started engine is released before its first call holds it", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);

  assert.deepEqual(child.references, ["child.unref", "stdin.unref", "stdout.unref", "child.ref", "stdin.ref", "stdout.ref"]);

  child.answer(0, 0);
  await calling;
});

test("the child and both pipes are held while a call is outstanding", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);

  assert.deepEqual(child.held, { child: true, stdin: true, stdout: true });

  child.answer(0, 0);
  await calling;
});

test("the child and both pipes are released once the only call has answered", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);
  child.answer(0, 0);
  await calling;

  assert.deepEqual(child.held, { child: false, stdin: false, stdout: false });
});

test("the engine stays held until the last outstanding call answers", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const first = transport.call(0n, "Echo", NOTHING);
  const second = transport.call(0n, "Echo", NOTHING);

  child.answer(1, 0);
  await second;
  assert.deepEqual(child.held, { child: true, stdin: true, stdout: true });

  child.answer(0, 0);
  await first;
  assert.deepEqual(child.held, { child: false, stdin: false, stdout: false });
});

test("a second call does not reference the engine again while one is outstanding", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const first = transport.call(0n, "Echo", NOTHING);
  const referencesAfterFirstCall = child.references.length;
  const second = transport.call(0n, "Echo", NOTHING);

  assert.equal(child.references.length, referencesAfterFirstCall);

  child.answer(0, 0);
  child.answer(1, 0);
  await Promise.all([first, second]);
});

test("stopping an idle engine holds it so the caller's wait keeps the event loop alive", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);
  child.answer(0, 0);
  await calling;

  const closing = transport.close();

  assert.deepEqual(child.held, { child: true, stdin: true, stdout: true });
  await closing;
});

test("an idle engine does not keep the host alive, and goes when the host does", { timeout: 30_000 }, async (t) => {
  const script = `
    import { spawn } from "node:child_process";
    const { SubprocessTransport } = await import(process.env.TRANSPORT_MODULE_URL);
    const transport = new SubprocessTransport({
      locate: () => process.env.FAKE_ENGINE_PATH,
      launcher: (program, args, options) => spawn(process.execPath, [program, ...args], options),
    });
    const result = await transport.call(0n, "GetVersion", new Uint8Array());
    process.exitCode = result.status;
  `;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TRANSPORT_MODULE_URL: new URL("../../src/internal/subprocess.js", import.meta.url).href,
      FAKE_ENGINE_PATH: fakeEnginePath,
    },
  });
  t.after(() => {
    host.kill("SIGKILL");
  });

  // "close" waits for the stderr pipe the engine inherited, so it fires only once the engine has gone too
  const exitCode = await new Promise<number | null>((resolve) => {
    host.on("close", (code) => {
      resolve(code);
    });
  });

  assert.equal(exitCode, 0);
});

// one engine, and starting a new one

test("creating three configurations starts one engine", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  await createConfig(transport);
  await createConfig(transport);
  await createConfig(transport);

  assert.equal(launches.length, 1);
});

test("three configurations get three different handles", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const first = await createConfig(transport);
  const second = await createConfig(transport);
  const third = await createConfig(transport);

  assert.equal(first, 1n);
  assert.equal(second, 2n);
  assert.equal(third, 3n);
});

test("a call on a handle reaches the engine with the handle that engine issued", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child) });
  t.after(() => transport.close());

  const creating = transport.call(0n, "CreateConfig", NOTHING);
  child.answer(0, 0, createConfigPayload(77n));
  const handle = handleIn((await creating).payload);

  const calling = transport.call(handle, "Echo", NOTHING);

  assert.equal(handle, 1n);
  assert.equal(child.requestAt(1).handle, 77n);

  child.answer(1, 0);
  await calling;
});

test("the next call after an exit starts a new engine", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  await assert.rejects(transport.call(0n, "Exit", ascii("3")), EngineExitedError);
  assert.equal(transport.pid, undefined);

  const result = await transport.call(0n, "GetVersion", NOTHING);

  assert.equal(result.status, 0);
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0]?.pid, launches[1]?.pid);
});

// the engine exiting

test("an engine exiting fails every waiting call with its exit status", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const results = await Promise.allSettled([
    transport.call(0n, "Echo", echoRequest(ONE_MINUTE_MS)),
    transport.call(0n, "Echo", echoRequest(ONE_MINUTE_MS)),
    transport.call(0n, "Exit", ascii("7")),
  ]);

  const firstFailure = rejectionOf(results[0]);
  const secondFailure = rejectionOf(results[1]);
  const exitFailure = rejectionOf(results[2]);
  assert.ok(firstFailure instanceof EngineExitedError);
  assert.ok(secondFailure instanceof EngineExitedError);
  assert.ok(exitFailure instanceof EngineExitedError);
  assert.equal(firstFailure.exitCode, 7);
  assert.equal(firstFailure.signal, null);
  assert.equal(secondFailure.exitCode, 7);
  assert.equal(exitFailure.exitCode, 7);
});

test("an engine killed by a signal fails every waiting call with that signal", { skip: process.platform === "win32" }, async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const results = await Promise.allSettled([
    transport.call(0n, "Echo", echoRequest(ONE_MINUTE_MS)),
    transport.call(0n, "Kill", NOTHING),
  ]);

  const waitingFailure = rejectionOf(results[0]);
  const killFailure = rejectionOf(results[1]);
  assert.ok(waitingFailure instanceof EngineExitedError);
  assert.ok(killFailure instanceof EngineExitedError);
  assert.equal(waitingFailure.signal, "SIGKILL");
  assert.equal(waitingFailure.exitCode, null);
  assert.equal(killFailure.signal, "SIGKILL");
});

test("closing the transport fails a call still waiting on the engine", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", echoRequest(ONE_MINUTE_MS));
  const closing = transport.close();

  await assert.rejects(calling, EngineExitedError);
  await closing;
});

// handles and engines

test("a handle from an engine that has exited is refused with EngineExitedError", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const handle = await createConfig(transport);
  await assert.rejects(transport.call(0n, "Exit", ascii("4")), EngineExitedError);

  await assert.rejects(transport.call(handle, "Echo", echoRequest(0)), (error: unknown) => {
    assert.ok(error instanceof EngineExitedError);
    assert.equal(error.exitCode, 4);
    return true;
  });
});

test("a handle from an exited engine is refused while a new engine is running", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const oldHandle = await createConfig(transport);
  await assert.rejects(transport.call(0n, "Exit", ascii("4")), EngineExitedError);
  await createConfig(transport);
  assert.equal(launches.length, 2);

  await assert.rejects(transport.call(oldHandle, "Echo", echoRequest(0)), EngineExitedError);
});

test("a handle from an exited engine never reaches a new engine that issued the same engine handle", async (t) => {
  const children: HandBuiltChild[] = [];
  const transport = new SubprocessTransport({
    locate: () => "engine",
    launcher: () => {
      const child = new HandBuiltChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  t.after(() => transport.close());

  const creatingFirst = transport.call(0n, "CreateConfig", NOTHING);
  const firstEngine = children[0] as HandBuiltChild;
  firstEngine.answer(0, 0, createConfigPayload(1n));
  const oldHandle = handleIn((await creatingFirst).payload);

  firstEngine.emit("close", 9, null);

  const creatingSecond = transport.call(0n, "CreateConfig", NOTHING);
  const secondEngine = children[1] as HandBuiltChild;
  secondEngine.answer(0, 0, createConfigPayload(1n));
  await creatingSecond;

  await assert.rejects(transport.call(oldHandle, "Echo", NOTHING), EngineExitedError);

  assert.equal(secondEngine.requests.length, 1);
});

test("the configuration a new engine numbered the same still works under its own handle", async (t) => {
  const children: HandBuiltChild[] = [];
  const transport = new SubprocessTransport({
    locate: () => "engine",
    launcher: () => {
      const child = new HandBuiltChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  t.after(() => transport.close());

  const creatingFirst = transport.call(0n, "CreateConfig", NOTHING);
  const firstEngine = children[0] as HandBuiltChild;
  firstEngine.answer(0, 0, createConfigPayload(1n));
  const oldHandle = handleIn((await creatingFirst).payload);

  firstEngine.emit("close", 9, null);

  const creatingSecond = transport.call(0n, "CreateConfig", NOTHING);
  const secondEngine = children[1] as HandBuiltChild;
  secondEngine.answer(0, 0, createConfigPayload(1n));
  const newHandle = handleIn((await creatingSecond).payload);

  const calling = transport.call(newHandle, "Echo", NOTHING);

  assert.notEqual(newHandle, oldHandle);
  assert.equal(secondEngine.requestAt(1).handle, 1n);

  secondEngine.answer(1, 0);
  await calling;
});

test("releasing a handle from an engine that has exited answers status 0 and starts nothing", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const handle = await createConfig(transport);
  await assert.rejects(transport.call(0n, "Exit", ascii("4")), EngineExitedError);

  const status = await transport.release(handle);

  assert.equal(status, 0);
  assert.equal(launches.length, 1);
});

test("a call on an unknown handle answers status -3", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const result = await transport.call(99n, "Echo", NOTHING);

  assert.equal(result.status, -3);
  assert.equal(launches.length, 0);
});

test("releasing an unknown handle answers status -3", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const status = await transport.release(99n);

  assert.equal(status, -3);
  assert.equal(launches.length, 0);
});

test("a handle that has been released answers status -3", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const released = await createConfig(transport);
  await createConfig(transport);
  await transport.release(released);

  const result = await transport.call(released, "Echo", NOTHING);

  assert.equal(result.status, -3);
});

// releasing and stopping

test("releasing a configuration answers status 0", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const handle = await createConfig(transport);

  assert.equal(await transport.release(handle), 0);
});

test("releasing the last configuration stops the engine", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const handle = await createConfig(transport);
  const pid = runningPid(transport);

  await transport.release(handle);

  assert.equal(transport.pid, undefined);
  assert.equal(isRunning(pid), false);
});

test("creating a configuration after the last was released starts a new engine", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  await transport.release(await createConfig(transport));

  await createConfig(transport);

  assert.equal(launches.length, 2);
});

test("releasing one of two configurations leaves the engine running", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  const first = await createConfig(transport);
  await createConfig(transport);
  const pid = runningPid(transport);

  await transport.release(first);

  assert.equal(transport.pid, pid);
  assert.equal(isRunning(pid), true);
  assert.equal(launches.length, 1);
});

test("closing stops the engine", async (t) => {
  const { launcher } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  await createConfig(transport);
  const pid = runningPid(transport);

  await transport.close();

  assert.equal(transport.pid, undefined);
  assert.equal(isRunning(pid), false);
});

test("closing twice is harmless", async (t) => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });
  t.after(() => transport.close());

  await createConfig(transport);

  await transport.close();
  await transport.close();

  assert.equal(transport.pid, undefined);
  assert.equal(launches.length, 1);
});

test("closing a transport that never started an engine is harmless", async () => {
  const { launcher, launches } = fakeEngineLauncher();
  const transport = new SubprocessTransport({ locate: () => fakeEnginePath, launcher });

  await transport.close();

  assert.equal(launches.length, 0);
});

test("an engine ignoring SIGTERM is ended with SIGKILL after the stop timeout", async (t) => {
  const child = new HandBuiltChild(true);
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child), stopTimeoutMs: 5 });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);
  child.answer(0, 0);
  await calling;

  await transport.close();

  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("an engine that stops on SIGTERM is not sent SIGKILL", async (t) => {
  const child = new HandBuiltChild();
  const transport = new SubprocessTransport({ locate: () => "engine", launcher: launcherOf(child), stopTimeoutMs: ONE_MINUTE_MS });
  t.after(() => transport.close());

  const calling = transport.call(0n, "Echo", NOTHING);
  child.answer(0, 0);
  await calling;

  await transport.close();

  assert.deepEqual(child.kills, ["SIGTERM"]);
});

// starting the engine

test("a spawn failure rejects with EngineNotFoundError", async (t) => {
  const missing = join(dirname(fakeEnginePath), "no-such-engine");
  const transport = new SubprocessTransport({ locate: () => missing });
  t.after(() => transport.close());

  await assert.rejects(transport.call(0n, "GetVersion", NOTHING), (error: unknown) => {
    assert.ok(error instanceof EngineNotFoundError);
    assert.ok(error.message.includes(missing));
    return true;
  });
});

test("a spawn failure leaves no engine behind", async (t) => {
  const missing = join(dirname(fakeEnginePath), "no-such-engine");
  const transport = new SubprocessTransport({ locate: () => missing });
  t.after(() => transport.close());

  await assert.rejects(transport.call(0n, "GetVersion", NOTHING), EngineNotFoundError);

  assert.equal(transport.pid, undefined);
});

test("a locator failure rejects the call", async (t) => {
  const failure = new EngineNotFoundError("nothing to run");
  const transport = new SubprocessTransport({
    locate: () => {
      throw failure;
    },
  });
  t.after(() => transport.close());

  await assert.rejects(transport.call(0n, "GetVersion", NOTHING), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
});

test("the engine's stderr reaches the host's stderr", async (t) => {
  const script = `
    import { spawn } from "node:child_process";
    const { SubprocessTransport } = await import(process.env.TRANSPORT_MODULE_URL);
    const transport = new SubprocessTransport({
      locate: () => process.env.FAKE_ENGINE_PATH,
      launcher: (program, args, options) => spawn(process.execPath, [program, ...args], options),
    });
    const result = await transport.call(0n, "GetVersion", new Uint8Array());
    await transport.close();
    process.exitCode = result.status;
  `;
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TRANSPORT_MODULE_URL: new URL("../../src/internal/subprocess.js", import.meta.url).href,
      FAKE_ENGINE_PATH: fakeEnginePath,
      FAKE_STDERR: "the fake engine says hello on stderr",
    },
  });
  t.after(() => {
    host.kill("SIGKILL");
  });

  let stderr = "";
  host.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    host.on("close", (code) => {
      resolve(code);
    });
  });

  assert.equal(exitCode, 0);
  assert.ok(stderr.includes("the fake engine says hello on stderr"), `stderr was: ${stderr}`);
});

// locating the engine

test("XCL_CORE_PATH wins over the platform package", () => {
  const program = locateEngine(
    search({
      env: { XCL_CORE_PATH: "/opt/xcl/xcl-core" },
      resolvePackage: notInstalled,
    }),
  );

  assert.equal(program, "/opt/xcl/xcl-core");
});

test("a missing XCL_CORE_PATH throws EngineNotFoundError", () => {
  const error = errorFrom(() =>
    locateEngine(
      search({
        env: { XCL_CORE_PATH: "/opt/xcl/missing" },
        exists: () => false,
      }),
    ),
  );

  assert.ok(error instanceof EngineNotFoundError);
  assert.ok(error.message.includes("/opt/xcl/missing"));
  assert.equal(error.packageName, "");
});

test("an empty XCL_CORE_PATH falls through to the platform package", () => {
  const program = locateEngine(search({ env: { XCL_CORE_PATH: "" } }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-linux-x64-gnu", "bin", "xcl-core"));
});

test("linux x64 glibc picks @jumppad-labs/xcl-lang-linux-x64-gnu", () => {
  const program = locateEngine(search({ platform: "linux", arch: "x64", libc: () => "gnu" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-linux-x64-gnu", "bin", "xcl-core"));
});

test("linux x64 musl picks @jumppad-labs/xcl-lang-linux-x64-musl", () => {
  const program = locateEngine(search({ platform: "linux", arch: "x64", libc: () => "musl" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-linux-x64-musl", "bin", "xcl-core"));
});

test("linux arm64 glibc picks @jumppad-labs/xcl-lang-linux-arm64-gnu", () => {
  const program = locateEngine(search({ platform: "linux", arch: "arm64", libc: () => "gnu" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-linux-arm64-gnu", "bin", "xcl-core"));
});

test("linux arm64 musl picks @jumppad-labs/xcl-lang-linux-arm64-musl", () => {
  const program = locateEngine(search({ platform: "linux", arch: "arm64", libc: () => "musl" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-linux-arm64-musl", "bin", "xcl-core"));
});

test("darwin x64 picks @jumppad-labs/xcl-lang-darwin-x64", () => {
  const program = locateEngine(search({ platform: "darwin", arch: "x64" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-darwin-x64", "bin", "xcl-core"));
});

test("darwin arm64 picks @jumppad-labs/xcl-lang-darwin-arm64", () => {
  const program = locateEngine(search({ platform: "darwin", arch: "arm64" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-darwin-arm64", "bin", "xcl-core"));
});

test("win32 x64 picks @jumppad-labs/xcl-lang-win32-x64 and its .exe", () => {
  const program = locateEngine(search({ platform: "win32", arch: "x64" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-win32-x64", "bin", "xcl-core.exe"));
});

test("win32 arm64 picks @jumppad-labs/xcl-lang-win32-arm64 and its .exe", () => {
  const program = locateEngine(search({ platform: "win32", arch: "arm64" }));

  assert.equal(program, join("/packages/@jumppad-labs/xcl-lang-win32-arm64", "bin", "xcl-core.exe"));
});

test("a missing package on glibc Linux names the package and how to install it", () => {
  const error = errorFrom(() => locateEngine(search({ libc: () => "gnu", resolvePackage: notInstalled })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.equal(error.packageName, "@jumppad-labs/xcl-lang-linux-x64-gnu");
  assert.ok(error.message.includes("@jumppad-labs/xcl-lang-linux-x64-gnu"));
  assert.ok(error.message.includes("npm install @jumppad-labs/xcl-lang-linux-x64-gnu"));
  assert.ok(error.message.includes("glibc"));
});

test("a missing package on musl Linux names the package and how to install it", () => {
  const error = errorFrom(() => locateEngine(search({ libc: () => "musl", resolvePackage: notInstalled })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.equal(error.packageName, "@jumppad-labs/xcl-lang-linux-x64-musl");
  assert.ok(error.message.includes("npm install @jumppad-labs/xcl-lang-linux-x64-musl"));
  assert.ok(error.message.includes("musl"));
});

test("a missing package on macOS names the package and how to install it", () => {
  const error = errorFrom(() => locateEngine(search({ platform: "darwin", arch: "arm64", resolvePackage: notInstalled })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.equal(error.packageName, "@jumppad-labs/xcl-lang-darwin-arm64");
  assert.ok(error.message.includes("npm install @jumppad-labs/xcl-lang-darwin-arm64"));
});

test("a missing package on Windows names the package and how to install it", () => {
  const error = errorFrom(() => locateEngine(search({ platform: "win32", arch: "x64", resolvePackage: notInstalled })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.equal(error.packageName, "@jumppad-labs/xcl-lang-win32-x64");
  assert.ok(error.message.includes("npm install @jumppad-labs/xcl-lang-win32-x64"));
});

test("a package installed without its binary throws EngineNotFoundError naming the package", () => {
  const error = errorFrom(() => locateEngine(search({ exists: () => false })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.equal(error.packageName, "@jumppad-labs/xcl-lang-linux-x64-gnu");
  assert.ok(error.message.includes("npm install @jumppad-labs/xcl-lang-linux-x64-gnu"));
});

test("an unsupported operating system throws EngineNotFoundError", () => {
  const error = errorFrom(() => locateEngine(search({ platform: "freebsd", arch: "x64" })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.ok(error.message.includes("freebsd x64"));
  assert.equal(error.packageName, "");
});

test("an unsupported architecture throws EngineNotFoundError", () => {
  const error = errorFrom(() => locateEngine(search({ platform: "linux", arch: "ia32" })));

  assert.ok(error instanceof EngineNotFoundError);
  assert.ok(error.message.includes("linux ia32"));
});

test("platformPackage answers undefined for an unsupported operating system", () => {
  assert.equal(platformPackage("freebsd", "x64", undefined), undefined);
});

test("platformPackage answers undefined for an unsupported architecture", () => {
  assert.equal(platformPackage("darwin", "ia32", undefined), undefined);
});

test("platformPackage takes Linux without a known C library as glibc", () => {
  assert.equal(platformPackage("linux", "x64", undefined), "@jumppad-labs/xcl-lang-linux-x64-gnu");
});

test("detectLibc names a C library", { skip: process.platform !== "linux" }, () => {
  assert.ok(["gnu", "musl"].includes(detectLibc()));
});

test("detectLibc leaves excludeNetwork as it found it", { skip: process.platform !== "linux" }, () => {
  const report = process.report as unknown as { excludeNetwork: boolean };
  const before = report.excludeNetwork;

  detectLibc();

  assert.equal(report.excludeNetwork, before);
});

test("sharedTransport answers the same transport each time", () => {
  assert.equal(sharedTransport(), sharedTransport());
});

test("sharedTransport starts no engine by being asked for", () => {
  assert.equal(sharedTransport().pid, undefined);
});

test("a worker thread gets its own engine from sharedTransport", { skip: process.platform === "win32" }, async (t) => {
  const shimDirectory = mkdtempSync(join(tmpdir(), "xcl-fake-engine-"));
  t.after(() => {
    rmSync(shimDirectory, { recursive: true, force: true });
  });

  const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  const shimPath = join(shimDirectory, "xcl-core");
  writeFileSync(shimPath, `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(fakeEnginePath)} "$@"\n`);
  chmodSync(shimPath, 0o755);

  const previousCorePath = process.env.XCL_CORE_PATH;
  process.env.XCL_CORE_PATH = shimPath;
  t.after(() => {
    if (previousCorePath === undefined) {
      delete process.env.XCL_CORE_PATH;
    } else {
      process.env.XCL_CORE_PATH = previousCorePath;
    }
  });
  t.after(() => sharedTransport().close());

  await createConfig(sharedTransport());
  const mainPid = sharedTransport().pid;
  await createConfig(sharedTransport());
  await createConfig(sharedTransport());
  const mainPidAfterThreeCalls = sharedTransport().pid;

  // a worker copies process.env when it starts, so it sees the XCL_CORE_PATH set above
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { sharedTransport } = await import(workerData.transportModuleUrl);
      const transport = sharedTransport();
      const result = await transport.call(0n, "CreateConfig", new Uint8Array());
      parentPort.postMessage({ status: result.status, pid: transport.pid });
      await transport.close();
    })();
  `;
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { transportModuleUrl: new URL("../../src/internal/subprocess.js", import.meta.url).href },
  });
  t.after(() => worker.terminate());

  const reply = await new Promise<{ status: number; pid: number | undefined }>((resolve, reject) => {
    let message: { status: number; pid: number | undefined } | undefined;
    worker.on("message", (received: { status: number; pid: number | undefined }) => {
      message = received;
    });
    worker.on("error", reject);
    worker.on("exit", () => {
      if (message === undefined) {
        reject(new Error("the worker exited without answering"));
      } else {
        resolve(message);
      }
    });
  });

  assert.equal(reply.status, 0);
  assert.notEqual(mainPid, undefined);
  assert.notEqual(reply.pid, undefined);
  assert.notEqual(reply.pid, mainPid);
  assert.equal(mainPidAfterThreeCalls, mainPid);
});
