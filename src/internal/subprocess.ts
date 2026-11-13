/**
 * The subprocess transport: the only code that knows about the engine process.
 *
 * The engine is `xcl-core`, from this platform's `@jumppad-labs/xcl-lang-*` package or from
 * `XCL_CORE_PATH`. It is started on first use, one per module graph, so one
 * per process and one per worker thread, and every configuration created there
 * shares it. Frames cross its pipes as a 4-byte big-endian length followed by
 * a `Request` or `Response` of `transport.proto`, read as `data` events on the
 * event loop and matched to their callers by request id, so a `Poll` waiting
 * for seconds holds up nothing.
 *
 * The child and its pipes are referenced only while a call is outstanding, so
 * an idle engine never keeps Node alive. A host that exits, or dies, closes
 * the engine's input, and the engine releases every configuration and exits.
 *
 * The handles given out are the transport's own, mapped to the engine that
 * issued each one, so a configuration from an engine that has exited is
 * refused by name rather than reaching whichever configuration a new engine
 * numbered the same.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { EngineExitedError, EngineNotFoundError } from "../errors.js";
import { CreateConfigResponseSchema } from "./core/xcl/core/v1/core_pb.js";
import { RequestSchema, ResponseSchema } from "./core/xcl/core/v1/transport_pb.js";
import { signedStatus, STATUS_OK, STATUS_UNKNOWN_HANDLE, type CallResult, type Transport } from "./transport.js";

const FRAME_HEADER_SIZE = 4;

/** The method name the frame protocol reserves for freeing a handle. */
const RELEASE_METHOD = "Release";

/** How long stopping the engine waits after SIGTERM, in milliseconds. */
const STOP_TIMEOUT_MS = 5000;

/** The C library of a Linux host. */
export type Libc = "gnu" | "musl";

/** The engine package for a platform, or undefined for a platform with none. */
export function platformPackage(platform: string, arch: string, libc: Libc | undefined): string | undefined {
  if (arch !== "x64" && arch !== "arm64") {
    return undefined;
  }
  if (platform === "linux") {
    return `@jumppad-labs/xcl-lang-linux-${arch}-${libc ?? "gnu"}`;
  }
  if (platform === "darwin" || platform === "win32") {
    return `@jumppad-labs/xcl-lang-${platform}-${arch}`;
  }
  return undefined;
}

/** The C library this Node was built against: glibc when its report names a glibc version, musl otherwise. */
export function detectLibc(): Libc {
  const report = process.report as unknown as { excludeNetwork: boolean; getReport(): { header: { glibcVersionRuntime?: string } } };
  // a report otherwise looks up every network interface, which can take seconds
  const excludeNetwork = report.excludeNetwork;
  report.excludeNetwork = true;
  try {
    return report.getReport().header.glibcVersionRuntime ? "gnu" : "musl";
  } finally {
    report.excludeNetwork = excludeNetwork;
  }
}

/** Where to look for the engine: replaceable by tests. */
export interface EngineSearch {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  libc: () => Libc;
  /** The path of a package's `package.json`; throws when it is not installed. */
  resolvePackage: (packageName: string) => string;
  exists: (path: string) => boolean;
}

function defaultSearch(): EngineSearch {
  const require = createRequire(import.meta.url);
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    libc: detectLibc,
    resolvePackage: (packageName) => require.resolve(`${packageName}/package.json`),
    exists: existsSync,
  };
}

/** The path of the `xcl-core` to run: `XCL_CORE_PATH` if set, otherwise this platform's package. */
export function locateEngine(search: EngineSearch = defaultSearch()): string {
  const override = search.env.XCL_CORE_PATH;
  if (override) {
    if (!search.exists(override)) {
      throw new EngineNotFoundError(`the xcl engine was not found at ${override}, the path XCL_CORE_PATH names`);
    }
    return override;
  }

  const libc = search.platform === "linux" ? search.libc() : undefined;
  const packageName = platformPackage(search.platform, search.arch, libc);
  const where = `${search.platform} ${search.arch}${libc ? ` (${libc === "gnu" ? "glibc" : "musl"})` : ""}`;
  if (packageName === undefined) {
    throw new EngineNotFoundError(`xcl has no engine for ${where}`);
  }

  let manifest: string;
  try {
    manifest = search.resolvePackage(packageName);
  } catch {
    throw new EngineNotFoundError(
      `the xcl engine package ${packageName} for ${where} is not installed. Install it with: npm install ${packageName}. ` +
        "It is an optional dependency of xcl-lang, so --omit=optional, --no-optional or a lockfile made on another platform leaves it out",
      packageName,
    );
  }

  const program = join(dirname(manifest), "bin", search.platform === "win32" ? "xcl-core.exe" : "xcl-core");
  if (!search.exists(program)) {
    throw new EngineNotFoundError(`the xcl engine package ${packageName} for ${where} has no engine at ${program}. Reinstall it with: npm install ${packageName}`, packageName);
  }
  return program;
}

/** Starts the engine: replaceable by tests. */
export type Launcher = (program: string, args: string[], options: SpawnOptions) => ChildProcess;

/** What a transport can be built with. */
export interface SubprocessTransportOptions {
  /** Finds the program to run, by default `locateEngine`. */
  locate?: () => string;
  /** Starts it, by default `child_process.spawn`. */
  launcher?: Launcher;
  /** How long stopping waits after SIGTERM before SIGKILL, in milliseconds. */
  stopTimeoutMs?: number;
}

interface Waiter {
  resolve: (result: CallResult) => void;
  reject: (reason: Error) => void;
}

/** A stream of the child's whose hold on the event loop can be released. */
type Referenced = { ref?: () => unknown; unref?: () => unknown };

/** One running engine and everything waiting on it. */
class Engine {
  readonly waiters = new Map<bigint, Waiter>();
  /** The transport handles of the configurations this engine holds. */
  readonly handles = new Set<bigint>();
  /** How many CreateConfig calls are on their way to it. */
  creating = 0;
  ended = false;
  failure: Error | undefined;
  chunks: Buffer[] = [];
  buffered = 0;
  frameSize: number | undefined;
  readonly closed: Promise<void>;
  markClosed!: () => void;

  constructor(
    readonly child: ChildProcess,
    readonly stdin: Writable,
    readonly stdout: Readable,
  ) {
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }
}

/** Calls the engine program, started beside this process on first use. */
export class SubprocessTransport implements Transport {
  private readonly locate: () => string;
  private readonly launcher: Launcher;
  private readonly stopTimeoutMs: number;
  private engine: Engine | undefined;
  private nextRequestId = 1n;
  private nextHandle = 1n;
  private readonly handles = new Map<bigint, { engine: Engine; engineHandle: bigint }>();

  constructor(options: SubprocessTransportOptions = {}) {
    this.locate = options.locate ?? locateEngine;
    this.launcher = options.launcher ?? spawn;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  /** The process id of the running engine, or undefined when none is running. */
  get pid(): number | undefined {
    return this.engine?.child.pid;
  }

  async call(handle: bigint, method: string, request: Uint8Array): Promise<CallResult> {
    if (handle === 0n) {
      return this.callWithoutHandle(method, request);
    }

    const entry = this.handles.get(handle);
    if (entry === undefined) {
      return { status: STATUS_UNKNOWN_HANDLE, payload: new Uint8Array() };
    }
    return this.exchange(entry.engine, entry.engineHandle, method, request);
  }

  async release(handle: bigint): Promise<number> {
    const entry = this.handles.get(handle);
    if (entry === undefined) {
      return STATUS_UNKNOWN_HANDLE;
    }
    this.handles.delete(handle);

    const { engine, engineHandle } = entry;
    engine.handles.delete(handle);
    if (engine.ended) {
      // the configuration went with its engine; there is nothing left to free
      return STATUS_OK;
    }

    let status = STATUS_OK;
    try {
      status = (await this.exchange(engine, engineHandle, RELEASE_METHOD, new Uint8Array())).status;
    } catch (error) {
      if (!(error instanceof EngineExitedError)) {
        throw error;
      }
    }

    if (engine.handles.size === 0 && engine.creating === 0 && this.engine === engine) {
      this.engine = undefined;
      await this.stop(engine);
    }
    return status;
  }

  async close(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
    if (engine !== undefined) {
      await this.stop(engine);
    }
  }

  private async callWithoutHandle(method: string, request: Uint8Array): Promise<CallResult> {
    const engine = this.runningEngine();
    if (method !== "CreateConfig") {
      return this.exchange(engine, 0n, method, request);
    }

    engine.creating += 1;
    try {
      const result = await this.exchange(engine, 0n, method, request);
      if (result.status !== STATUS_OK) {
        return result;
      }
      const engineHandle = fromBinary(CreateConfigResponseSchema, result.payload).handle;
      const handle = this.nextHandle;
      this.nextHandle += 1n;
      this.handles.set(handle, { engine, engineHandle });
      engine.handles.add(handle);
      return { status: result.status, payload: toBinary(CreateConfigResponseSchema, create(CreateConfigResponseSchema, { handle })) };
    } finally {
      engine.creating -= 1;
    }
  }

  private runningEngine(): Engine {
    if (this.engine === undefined || this.engine.ended) {
      this.engine = this.start();
    }
    return this.engine;
  }

  private start(): Engine {
    const program = this.locate();
    const child = this.launcher(program, ["--serve"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const { stdin, stdout } = child;
    if (stdin === null || stdout === null) {
      throw new EngineNotFoundError(`the xcl engine at ${program} could not be started: it has no pipes`);
    }

    const engine = new Engine(child, stdin, stdout);
    // a write to an engine that has gone must not throw: the exit is reported
    // to every waiter when the child closes
    stdin.on("error", () => {});
    stdout.on("error", () => {});
    stdout.on("data", (chunk: Buffer) => {
      this.onData(engine, chunk);
    });
    child.on("error", (error) => {
      if (child.pid === undefined) {
        this.ended(engine, new EngineNotFoundError(`the xcl engine at ${program} could not be started: ${error.message}`));
      }
    });
    child.on("close", (code, signal) => {
      this.ended(engine, new EngineExitedError(code, signal));
    });

    // nothing is outstanding yet, so an engine started and left idle holds nothing
    this.letGo(engine);
    return engine;
  }

  private exchange(engine: Engine, handle: bigint, method: string, payload: Uint8Array): Promise<CallResult> {
    if (engine.ended) {
      return Promise.reject(engine.failure ?? new EngineExitedError(null, null));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1n;
    const frame = toBinary(RequestSchema, create(RequestSchema, { id, handle, method, payload }));
    const header = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
    header.writeUInt32BE(frame.length);

    return new Promise((resolve, reject) => {
      if (engine.waiters.size === 0) {
        this.hold(engine);
      }
      engine.waiters.set(id, { resolve, reject });
      engine.stdin.write(Buffer.concat([header, frame]));
    });
  }

  private onData(engine: Engine, chunk: Buffer): void {
    engine.chunks.push(chunk);
    engine.buffered += chunk.length;

    for (;;) {
      if (engine.frameSize === undefined) {
        if (engine.buffered < FRAME_HEADER_SIZE) {
          return;
        }
        engine.frameSize = this.take(engine, FRAME_HEADER_SIZE).readUInt32BE(0);
      }
      if (engine.buffered < engine.frameSize) {
        return;
      }
      const body = this.take(engine, engine.frameSize);
      engine.frameSize = undefined;
      this.onFrame(engine, body);
    }
  }

  /** The next `size` buffered bytes, joining chunks only when a frame spans them. */
  private take(engine: Engine, size: number): Buffer {
    const joined = engine.chunks.length === 1 ? (engine.chunks[0] as Buffer) : Buffer.concat(engine.chunks, engine.buffered);
    const taken = joined.subarray(0, size);
    const rest = joined.subarray(size);
    engine.chunks = rest.length > 0 ? [rest] : [];
    engine.buffered = rest.length;
    return taken;
  }

  private onFrame(engine: Engine, body: Buffer): void {
    let response;
    try {
      response = fromBinary(ResponseSchema, body);
    } catch {
      // a garbled frame ends the engine, and its exit reaches every waiter
      engine.child.kill("SIGKILL");
      return;
    }

    const waiter = engine.waiters.get(response.id);
    if (waiter === undefined) {
      return;
    }
    engine.waiters.delete(response.id);
    if (engine.waiters.size === 0 && !engine.ended) {
      this.letGo(engine);
    }
    waiter.resolve({ status: signedStatus(response.status), payload: response.payload });
  }

  /** Records that `engine` has stopped and fails every call still waiting on it. */
  private ended(engine: Engine, failure: Error): void {
    if (engine.ended) {
      return;
    }
    engine.ended = true;
    engine.failure = failure;
    if (this.engine === engine) {
      this.engine = undefined;
    }
    const waiters = [...engine.waiters.values()];
    engine.waiters.clear();
    for (const waiter of waiters) {
      waiter.reject(failure);
    }
    engine.markClosed();
  }

  /** Ends `engine` with SIGTERM, then SIGKILL if it does not exit within a bounded wait. */
  private async stop(engine: Engine): Promise<void> {
    if (engine.ended) {
      return;
    }
    // the caller is awaiting this, so the event loop must stay alive for it
    this.hold(engine);
    engine.child.kill("SIGTERM");

    const timer = setTimeout(() => {
      engine.child.kill("SIGKILL");
    }, this.stopTimeoutMs);
    try {
      await engine.closed;
    } finally {
      clearTimeout(timer);
    }
  }

  private hold(engine: Engine): void {
    engine.child.ref();
    (engine.stdin as Referenced).ref?.();
    (engine.stdout as Referenced).ref?.();
  }

  private letGo(engine: Engine): void {
    engine.child.unref();
    (engine.stdin as Referenced).unref?.();
    (engine.stdout as Referenced).unref?.();
  }
}

let defaultTransport: SubprocessTransport | undefined;

/** The transport of this module graph: one per process, and one per worker thread. */
export function sharedTransport(): SubprocessTransport {
  defaultTransport ??= new SubprocessTransport();
  return defaultTransport;
}
