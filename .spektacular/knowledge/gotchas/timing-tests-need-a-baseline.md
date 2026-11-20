---
tags: [testing, typescript, events, windows, flaky]
---

# Timing in tests: drop zero-able durations and compare delays against a baseline

Two kinds of timing assertion have flaked this suite on CI and must not be written again:

- **Comparing pretty logs timed separately.** A zero duration is left off the line entirely (Go's `events/slog.go`, which `prettyline` matches), and a quick operation measures zero on Windows' coarse clock in one run and not another. `test/integration/prettylog.test.ts` `normalised` and `test/parity/parity.test.ts` drop ` duration=...` rather than masking its value; do the same in any new comparison.
- **A fixed limit on how late a timer fires.** `test/integration/event-loop.test.ts` once held the event loop's 99th-percentile delay under 50 ms and failed at 55.7 ms on `macos-15-intel`. It now measures the same timer and HTTP requests for as long as the apply takes with nothing running, and asserts the apply adds less than 50 ms to that baseline. A blocked event loop would add close to the whole 2 s apply, so the test still catches a regression.

See [[flaky-tests-are-fixed-not-rerun]].
