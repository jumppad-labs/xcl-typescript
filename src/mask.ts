/**
 * Masks for sensitive values in state and events. A mask says how a sensitive
 * value is written where it would otherwise be written in plain text: in
 * state, with `stateMask`, and in event data, with `eventMask`. State needs a
 * reversible mask, so the value can be read back, and `aes256gcm` is the one
 * that is. Events are redacted unless another mask is given.
 */

import type { MessageInitShape } from "@bufbuild/protobuf";

import type { MaskSchema } from "./internal/core/xcl/core/v1/core_pb.js";

/** A mask to give as `stateMask` or `eventMask`; build one with the functions of this module. */
export interface Mask {
  /** The mask's name: `aes256gcm`, `hmac_sha256`, `redact` or `omit`. */
  readonly name: string;
  /** The mask as `CreateConfig` carries it. @internal */
  readonly message: MessageInitShape<typeof MaskSchema>;
}

/** Encrypts sensitive values with AES-256-GCM under a 32-byte key. Reversible, so it suits state. */
export function aes256gcm(key: Uint8Array): Mask {
  if (key.length !== 32) {
    throw new RangeError(`an AES-256-GCM key is 32 bytes, got ${key.length}`);
  }
  return { name: "aes256gcm", message: { kind: { case: "aes256gcmKey", value: key } } };
}

/** Replaces sensitive values with their HMAC-SHA256 under `key`. One-way, so values still compare. */
export function hmacSha256(key: Uint8Array): Mask {
  if (key.length === 0) {
    throw new RangeError("an HMAC-SHA256 key must not be empty");
  }
  return { name: "hmac_sha256", message: { kind: { case: "hmacSha256Key", value: key } } };
}

/** Replaces sensitive values with the marker `(sensitive)`. The default for events. */
export function redact(): Mask {
  return { name: "redact", message: { kind: { case: "redact", value: true } } };
}

/** Leaves sensitive values out entirely. */
export function omit(): Mask {
  return { name: "omit", message: { kind: { case: "omit", value: true } } };
}
