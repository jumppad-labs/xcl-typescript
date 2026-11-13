/** An xcl error logged as JSON through pino's and winston's standard error handling, with no other configuration. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";

import pino from "pino";
import winston from "winston";

import { Config, LocalRegistry } from "../../src/index.js";
import { isolateHome, missingEngine, missingPlugin, pluginPath, RECORDING_PLUGIN, ROOT, testDirectory } from "../helpers/engine.js";

const needsPlugin = missingEngine() || missingPlugin(RECORDING_PLUGIN);
isolateHome();

const FIXTURE = join(ROOT, "test", "integration", "fixtures", "unsupported-block", "main.xcl");

const GO_REPORT = `Error: Unsupported block type

  on ${FIXTURE} line 7, in resource.recording.two, field nope[0]:
     5 | 
     6 | resource "recording" "two" {
     7 |   nope {
     8 |     a = 1
     9 |   }

Blocks of type "nope" are not expected here.`;

async function rejected(t: TestContext): Promise<Error> {
  const local = new LocalRegistry();
  local.registerExternalPlugin(pluginPath(RECORDING_PLUGIN));
  const config: Config = await new Config({ registries: [local], statePath: join(testDirectory(t), "state") }).setup();
  t.after(() => config.close());
  const error = await config.apply(FIXTURE).catch((caught: unknown) => caught);
  assert.ok(error instanceof Error);
  return error;
}

type Logged = { problems: Array<Record<string, unknown>>; report: string };

function assertCarriesProblems(logged: Logged): void {
  assert.equal(logged.report, GO_REPORT);
  assert.deepEqual(logged.problems, [
    {
      file: FIXTURE,
      line: 7,
      column: 3,
      summary: "Unsupported block type",
      detail: 'Blocks of type "nope" are not expected here.',
      entity: "resource.recording.two",
      field: "nope[0]",
    },
  ]);
}

test("pino's standard error serializer carries each problem and the plain report", { skip: needsPlugin }, async (t) => {
  const error = await rejected(t);
  const lines: string[] = [];
  const logger = pino({}, { write: (line: string) => lines.push(line) });

  logger.error({ err: error }, "apply failed");

  assertCarriesProblems((JSON.parse(lines[0] as string) as { err: Logged }).err);
});

test("winston's error format carries each problem and the plain report", { skip: needsPlugin }, async (t) => {
  const error = await rejected(t);
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = winston.createLogger({
    format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.json()),
    transports: [new winston.transports.Stream({ stream })],
  });

  logger.error(error);

  assertCarriesProblems(JSON.parse(lines[0] as string) as Logged);
});
