/**
 * The typed client: CoreService messages in, messages out.
 *
 * `call` encodes a request from the generated service descriptor, passes it to
 * the transport, and decodes the response into the method's output message, or
 * throws the error class for the engine's error code. On first use it checks
 * that the engine is the version the package was built for.
 */

import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";

import { EngineVersionError, fromProto, InternalBindingError } from "../errors.js";
import { ENGINE_VERSION, PACKAGE_VERSION } from "../version.js";
import { CoreService, ErrorSchema, GetVersionRequestSchema, GetVersionResponseSchema } from "./core/xcl/core/v1/core_pb.js";
import { STATUS_ERROR, STATUS_OK, type Transport } from "./transport.js";

/** The one version of the frames and statuses this package speaks. */
const ABI_VERSION = 1;

type Methods = typeof CoreService.method;

/** A CoreService method, by its generated name. */
export type MethodName = keyof Methods;

/** What a method's request can be built from. */
export type RequestOf<M extends MethodName> = Methods[M]["input"] extends DescMessage ? MessageInitShape<Methods[M]["input"]> : never;

/** A method's decoded response. */
export type ResponseOf<M extends MethodName> = Methods[M]["output"] extends DescMessage ? MessageShape<Methods[M]["output"]> : never;

/** The form versions are compared in: the tag's leading `v` removed. */
function normalise(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

/** Dispatches CoreService methods over a transport. */
export class Client {
  private checked: Promise<string> | undefined;

  constructor(readonly transport: Transport) {}

  /** Calls `method` on `handle`; an engine error throws its class, and a negative status the binding error. */
  async call<M extends MethodName>(handle: bigint, method: M, request: RequestOf<M>): Promise<ResponseOf<M>> {
    await this.ensureVersion();
    const descriptor = CoreService.method[method];
    const input = descriptor.input as DescMessage;
    const body = toBinary(input, create(input, request as MessageInitShape<DescMessage>));
    const { status, payload } = await this.transport.call(handle, descriptor.name, body);
    return decode(descriptor.name, status, payload, descriptor.output as DescMessage) as ResponseOf<M>;
  }

  /** Frees the configuration behind `handle`. */
  async release(handle: bigint): Promise<void> {
    const status = await this.transport.release(handle);
    if (status !== STATUS_OK) {
      throw new InternalBindingError("Release", status);
    }
  }

  /** The engine's version, as GetVersion reports it. */
  engineVersion(): Promise<string> {
    return this.ensureVersion();
  }

  private ensureVersion(): Promise<string> {
    this.checked ??= this.checkVersion().catch((error: unknown) => {
      // a failed check is not remembered: the next use checks whichever engine it starts
      this.checked = undefined;
      throw error;
    });
    return this.checked;
  }

  private async checkVersion(): Promise<string> {
    const request = toBinary(GetVersionRequestSchema, create(GetVersionRequestSchema));
    const { status, payload } = await this.transport.call(0n, "GetVersion", request);
    const response = decode("GetVersion", status, payload, GetVersionResponseSchema) as MessageShape<typeof GetVersionResponseSchema>;

    if (response.abiVersion !== ABI_VERSION) {
      await this.transport.close();
      throw new EngineVersionError(
        `the xcl engine implements ABI version ${response.abiVersion} (engine ${response.version}), but xcl-lang ${PACKAGE_VERSION} was built for ABI version ${ABI_VERSION} (engine ${ENGINE_VERSION}); install the xcl-lang package matching the engine`,
        ENGINE_VERSION,
        response.version,
      );
    }
    if (normalise(response.version) !== normalise(ENGINE_VERSION)) {
      await this.transport.close();
      throw new EngineVersionError(
        `the xcl engine reports version ${response.version}, but xcl-lang ${PACKAGE_VERSION} was built for engine ${ENGINE_VERSION}; the xcl-lang package only runs against the engine it bundles`,
        ENGINE_VERSION,
        response.version,
      );
    }
    return response.version;
  }
}

function decode(method: string, status: number, payload: Uint8Array, output: DescMessage): unknown {
  if (status === STATUS_ERROR) {
    throw fromProto(fromBinary(ErrorSchema, payload));
  }
  if (status !== STATUS_OK) {
    throw new InternalBindingError(method, status);
  }
  return fromBinary(output, payload);
}
