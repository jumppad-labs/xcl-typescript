/**
 * Ctrl-C as an abort signal. This is the only code in the package that touches
 * a signal listener, and only when a program calls it.
 */

const releases = new WeakMap<AbortSignal, () => void>();

/**
 * An `AbortSignal` that aborts on the next SIGINT, for one operation:
 *
 * ```ts
 * await config.apply("./infra", { signal: interruptSignal() });
 * ```
 *
 * Its listener is added with `process.once` and removed when the operation it
 * was passed to settles, so the program goes back to Node's default handling
 * as soon as the operation ends. Combined with a signal of the program's own
 * through `AbortSignal.any`, the listener is removed when it fires or when the
 * process exits.
 */
export function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  releases.set(controller.signal, () => {
    process.removeListener("SIGINT", onInterrupt);
  });
  return controller.signal;
}

/** @internal Removes the listener of a signal from `interruptSignal`, if it is one. */
export function releaseInterrupt(signal: AbortSignal | undefined): void {
  if (signal !== undefined) {
    releases.get(signal)?.();
  }
}
