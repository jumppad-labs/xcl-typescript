/**
 * The byte layer below the typed client, which the real transport and the
 * tests' fake both implement. Handles are the transport's own, not the
 * engine's.
 */

/** What a call answers with. `status` is signed. */
export interface CallResult {
  status: number;
  payload: Uint8Array;
}

/** Carries serialised CoreService calls to an engine. */
export interface Transport {
  /** Calls `method` on `handle` with a serialised request. */
  call(handle: bigint, method: string, request: Uint8Array): Promise<CallResult>;
  /** Frees the configuration behind `handle` and answers with a status. */
  release(handle: bigint): Promise<number>;
  /** Stops the engine, if one is running. A later call starts a new one. */
  close(): Promise<void>;
}

/** The call succeeded, and the payload is the method's response. */
export const STATUS_OK = 0;

/** The call failed, and the payload is an `Error` message. */
export const STATUS_ERROR = 1;

/** The engine never issued the handle, or has released it. */
export const STATUS_UNKNOWN_HANDLE = -3;

/** The status a `Response` carries as a two's-complement `uint32`, as a signed value. */
export function signedStatus(status: number): number {
  return status >= 2 ** 31 ? status - 2 ** 32 : status;
}
