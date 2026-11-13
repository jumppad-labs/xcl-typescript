---
tags: [typescript, node, errors, printing]
---

# Node's uncaught-error printing ignores `util.inspect.custom`

When an error goes uncaught, Node prints it through `fatalExceptionStackEnhancers.afterInspector` in `lib/internal/errors.js`, which calls `inspect` with `customInspect: false`. So `[util.inspect.custom]` runs for `console.error` and never for an uncaught throw, a rejected promise or a rejected top-level await. Confirmed by running the real-engine tests on Node 22.23.4, 24.22.2 and 26.13.0.

What Node does print for an uncaught error is `err.stack`, then the error's own enumerable properties. Text that must appear on an uncaught error therefore has to be in `stack`, placed between the first line and the first `\n    at` so Node's frame colouring leaves it alone. It cannot be coloured safely: `stack` is fixed when the error is built, and would carry escape codes into logs. Build the stitched `stack` after the error exists, not in the constructor: V8 captures the stack header before a subclass sets its `name`.

An enumerable data property holding multi-line text prints a second time as an escaped, quoted string. An own enumerable accessor prints as `[Getter]` instead, and still reaches `JSON.stringify` and `Object.assign`. pino's standard `err` serializer and winston's `format.errors()` both carry such an accessor with no configuration (pino 9.14.0, winston 3.19.0).

xcl-typescript carries an error's plain report in `stack` this way and adds no process listener such as `uncaughtExceptionMonitor`, because a listener is a process-wide side effect. Its tests start the uncaught program with `process.execPath`, so CI's Node matrix covers each version. To try another Node version locally, run the compiled tests in Podman on `node:<version>-slim`, mounting the checkout at its own path. The host-built engine and plugins run there unchanged.
