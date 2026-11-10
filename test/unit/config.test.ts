import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";

import { createConfigWith, type Config, type ConfigOptions } from "../../src/config.js";
import type { Entity } from "../../src/hydrate.js";
import { Diff, UNKNOWN } from "../../src/diff.js";
import {
  CancelledError,
  ConfigError,
  InternalBindingError,
  InternalError,
  InvalidArgumentError,
  InvalidSavedDataError,
  NotFoundError,
  NotUniqueError,
  OperationInProgressError,
  ProviderError,
  TypeNameClashError,
  UnknownTypeError,
} from "../../src/errors.js";
import { Client } from "../../src/internal/client.js";
import {
  CreateConfigRequestSchema,
  CreateConfigResponseSchema,
  EntitiesResponseSchema,
  EntityResponseSchema,
  FindByTypeRequestSchema,
  FindRequestSchema,
  OutputsResponseSchema,
  PollRequestSchema,
  PollResponseSchema,
  StartApplyRequestSchema,
  StartDiffRequestSchema,
  StartOperationResponseSchema,
  StartValidateRequestSchema,
  type GitHubRegistry as GitHubRegistryMessage,
  type LocalRegistry as LocalRegistryMessage,
} from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { POLL_WAIT_MS } from "../../src/internal/poll.js";
import type { CallResult } from "../../src/internal/transport.js";
import { GitHubRegistry, LocalRegistry } from "../../src/registry.js";
import { failed, FakeTransport, ok, type RecordedCall } from "../helpers/fake-transport.js";

const HANDLE = 7n;
const OPERATION_ID = 42n;

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function started(): CallResult {
  return ok(StartOperationResponseSchema, { operationId: OPERATION_ID });
}

function noTask(): CallResult {
  return ok(PollResponseSchema, {});
}

function eventTask(): CallResult {
  return ok(PollResponseSchema, { task: { case: "event", value: { source: "core", operation: "apply" } } });
}

function finished(): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: OPERATION_ID } } });
}

function finishedWithDiff(diff: unknown): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: OPERATION_ID, diffJson: json(diff) } } });
}

function finishedWithError(code: string, message: string): CallResult {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: OPERATION_ID, error: { code, message } } } });
}

function entityResponse(entity: unknown): CallResult {
  return ok(EntityResponseSchema, { entity: json(entity) });
}

function entitiesResponse(...entities: unknown[]): CallResult {
  return ok(EntitiesResponseSchema, { entities: entities.map(json) });
}

/** A transport that creates configurations and finishes every operation at its first poll. */
function engine(): FakeTransport {
  return new FakeTransport()
    .always("CreateConfig", () => ok(CreateConfigResponseSchema, { handle: HANDLE }))
    .always("StartValidate", () => started())
    .always("StartApply", () => started())
    .always("StartDiff", () => started())
    .always("StartLoad", () => started())
    .always("StartDestroy", () => started())
    .always("Poll", () => finished());
}

function open(transport: FakeTransport, options: ConfigOptions = {}): Promise<Config> {
  return createConfigWith(new Client(transport), options);
}

function onlyCall(transport: FakeTransport, method: string): RecordedCall {
  const calls = transport.callsOf(method);
  assert.equal(calls.length, 1, `expected exactly one ${method} call`);
  return calls[0] as RecordedCall;
}

interface HeldPoll {
  /** Resolves once the operation is waiting on its poll. */
  reached: Promise<void>;
  /** Answers the poll being held. */
  finish(result: CallResult): void;
}

/** Holds every poll open until the test answers it by hand. */
function holdPoll(transport: FakeTransport): HeldPoll {
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let finish!: (result: CallResult) => void;
  const answer = new Promise<CallResult>((resolve) => {
    finish = resolve;
  });
  transport.always("Poll", () => {
    markReached();
    return answer;
  });
  return { reached, finish };
}

// creating a configuration

test("a configuration is created on handle zero after the version check", async () => {
  const transport = engine();

  await open(transport);

  assert.deepEqual(
    transport.calls.map((call) => call.method),
    ["GetVersion", "CreateConfig"],
  );
  assert.equal(onlyCall(transport, "CreateConfig").handle, 0n);
});

test("the create request carries the registries in order", async () => {
  const transport = engine();
  const first = new LocalRegistry({ pluginPattern: "xcl-plugin-*" });
  first.registerExternalPlugin(["/opt/plugins/first", "--flag"]);
  first.registerPluginDirectory("/opt/plugins");
  const second = new GitHubRegistry({ trustedKeys: ["a key"], cacheDir: "/var/cache/xcl", token: "a-token", apiUrl: "https://github.example.com/api/v3" });
  second.registerPlugin("jumppad-labs/plugin-docker", "v1.2.3");
  const third = new LocalRegistry();
  third.registerPluginDirectory("/opt/third");

  await open(transport, { registries: [first, second, third] });

  const request = fromBinary(CreateConfigRequestSchema, onlyCall(transport, "CreateConfig").request);
  assert.deepEqual(
    request.registries.map((registry) => registry.kind.case),
    ["local", "github", "local"],
  );

  const firstMessage = request.registries[0]?.kind.value as LocalRegistryMessage;
  assert.equal(firstMessage.pluginPattern, "xcl-plugin-*");
  assert.deepEqual(firstMessage.externalPluginCommands[0]?.command, ["/opt/plugins/first", "--flag"]);
  assert.deepEqual(firstMessage.pluginDirectories, ["/opt/plugins"]);

  const secondMessage = request.registries[1]?.kind.value as GitHubRegistryMessage;
  assert.equal(secondMessage.plugins[0]?.repository, "jumppad-labs/plugin-docker");
  assert.equal(secondMessage.plugins[0]?.version, "v1.2.3");
  assert.deepEqual(secondMessage.trustedKeys, ["a key"]);
  assert.equal(secondMessage.cacheDir, "/var/cache/xcl");
  assert.equal(secondMessage.token, "a-token");
  assert.equal(secondMessage.apiUrl, "https://github.example.com/api/v3");

  const thirdMessage = request.registries[2]?.kind.value as LocalRegistryMessage;
  assert.deepEqual(thirdMessage.pluginDirectories, ["/opt/third"]);
});

test("the create request carries the state path", async () => {
  const transport = engine();

  await open(transport, { statePath: "/var/lib/xcl/state" });

  const request = fromBinary(CreateConfigRequestSchema, onlyCall(transport, "CreateConfig").request);
  assert.equal(request.stateStore?.kind.case, "path");
  assert.equal(request.stateStore?.kind.value, "/var/lib/xcl/state");
});

test("a create request with no options has no registries and no state store", async () => {
  const transport = engine();

  await open(transport);

  const request = fromBinary(CreateConfigRequestSchema, onlyCall(transport, "CreateConfig").request);
  assert.deepEqual(request.registries, []);
  assert.equal(request.stateStore, undefined);
});

test("a registration the engine refuses rejects with its class", async () => {
  const transport = engine().always("CreateConfig", () => failed("type_name_clash", "two registries declare resource.container"));

  await assert.rejects(open(transport), TypeNameClashError);
});

// validate

test("validate returns a promise that resolves once the operation is finished", async () => {
  const transport = engine();
  const config = await open(transport);

  const pending = config.validate("main.xcl");

  assert.ok(pending instanceof Promise);
  assert.equal(await pending, undefined);
  assert.equal(transport.callsOf("Poll").length, 1);
});

test("validate sends a single path as a list of one", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.validate("main.xcl");

  const call = onlyCall(transport, "StartValidate");
  assert.equal(call.handle, HANDLE);
  assert.deepEqual(fromBinary(StartValidateRequestSchema, call.request).paths, ["main.xcl"]);
});

test("validate sends an array of paths in order", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.validate(["first.xcl", "second.xcl"]);

  assert.deepEqual(fromBinary(StartValidateRequestSchema, onlyCall(transport, "StartValidate").request).paths, ["first.xcl", "second.xcl"]);
});

test("validate with no paths rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(config.validate([]), InvalidArgumentError);

  assert.equal(transport.callsOf("StartValidate").length, 0);
});

test("a finished validate carrying an error rejects with its class", async () => {
  const transport = engine().always("Poll", () => finishedWithError("config", "the configuration is invalid"));
  const config = await open(transport);

  await assert.rejects(config.validate("main.xcl"), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message, "the configuration is invalid");
    return true;
  });
});

// apply

test("apply returns a promise that resolves once the operation is finished", async () => {
  const transport = engine();
  const config = await open(transport);

  const pending = config.apply("main.xcl");

  assert.ok(pending instanceof Promise);
  assert.equal(await pending, undefined);
  assert.equal(transport.callsOf("Poll").length, 1);
});

test("apply sends a single path as a list of one", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.apply("main.xcl");

  const call = onlyCall(transport, "StartApply");
  assert.equal(call.handle, HANDLE);
  assert.deepEqual(fromBinary(StartApplyRequestSchema, call.request).paths, ["main.xcl"]);
});

test("apply sends an array of paths in order", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.apply(["first.xcl", "second.xcl"]);

  assert.deepEqual(fromBinary(StartApplyRequestSchema, onlyCall(transport, "StartApply").request).paths, ["first.xcl", "second.xcl"]);
});

test("apply with no paths rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(config.apply([]), InvalidArgumentError);

  assert.equal(transport.callsOf("StartApply").length, 0);
});

test("a finished apply carrying an error rejects with its class", async () => {
  const transport = engine().always("Poll", () => finishedWithError("provider", "the provider failed"));
  const config = await open(transport);

  await assert.rejects(config.apply("main.xcl"), ProviderError);
});

test("a cancelled apply rejects with its class", async () => {
  const transport = engine().always("Poll", () => finishedWithError("cancelled", "the operation was stopped"));
  const config = await open(transport);

  await assert.rejects(config.apply("main.xcl"), CancelledError);
});

// diff

test("diff returns a promise that resolves with the diff once finished", async () => {
  const transport = engine().always("Poll", () => finishedWithDiff({ summary: { create: 1, unchanged: 2 }, resources: [] }));
  const config = await open(transport);

  const pending = config.diff("main.xcl");

  assert.ok(pending instanceof Promise);
  const diff = await pending;
  assert.ok(diff instanceof Diff);
  assert.deepEqual(diff.summary, { create: 1, update: 0, replace: 0, delete: 0, unchanged: 2 });
  assert.equal(transport.callsOf("Poll").length, 1);
});

test("diff reports each changed attribute through the configuration", async () => {
  const transport = engine().always("Poll", () =>
    finishedWithDiff({
      summary: { update: 1 },
      resources: [
        {
          address: "resource.container.web",
          action: "update",
          changes: [
            { path: "ports[0].host_port", before: 80, after: 8080 },
            { path: "container_id", before: "abc123", unknown: true },
          ],
        },
      ],
    }),
  );
  const config = await open(transport);

  const diff = await config.diff("main.xcl");

  const changes = diff.resource("resource.container.web")?.changes;
  assert.equal(changes?.[0]?.path, "ports[0].hostPort");
  assert.equal(changes?.[0]?.before, 80);
  assert.equal(changes?.[0]?.after, 8080);
  assert.equal(changes?.[1]?.path, "containerId");
  assert.equal(changes?.[1]?.after, UNKNOWN);
  assert.equal(changes?.[1]?.unknown, true);
});

test("diff of an empty JSON object resolves with an empty diff", async () => {
  const transport = engine().always("Poll", () => finishedWithDiff({}));
  const config = await open(transport);

  const diff = await config.diff("main.xcl");

  assert.ok(diff instanceof Diff);
  assert.equal(diff.changed(), 0);
  assert.deepEqual(diff.resources, []);
});

test("diff sends a single path as a list of one", async () => {
  const transport = engine().always("Poll", () => finishedWithDiff({}));
  const config = await open(transport);

  await config.diff("main.xcl");

  const call = onlyCall(transport, "StartDiff");
  assert.equal(call.handle, HANDLE);
  assert.deepEqual(fromBinary(StartDiffRequestSchema, call.request).paths, ["main.xcl"]);
});

test("diff sends an array of paths in order", async () => {
  const transport = engine().always("Poll", () => finishedWithDiff({}));
  const config = await open(transport);

  await config.diff(["first.xcl", "second.xcl"]);

  assert.deepEqual(fromBinary(StartDiffRequestSchema, onlyCall(transport, "StartDiff").request).paths, ["first.xcl", "second.xcl"]);
});

test("diff keeps sensitive values hidden by default", async () => {
  const transport = engine().always("Poll", () => finishedWithDiff({}));
  const config = await open(transport);

  await config.diff("main.xcl");

  assert.equal(fromBinary(StartDiffRequestSchema, onlyCall(transport, "StartDiff").request).revealSensitive, false);
});

test("diff asks for sensitive values when told to reveal them", async () => {
  const transport = engine().always("Poll", () => finishedWithDiff({}));
  const config = await open(transport);

  await config.diff("main.xcl", { revealSensitive: true });

  assert.equal(fromBinary(StartDiffRequestSchema, onlyCall(transport, "StartDiff").request).revealSensitive, true);
});

test("diff with no paths rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(config.diff([]), InvalidArgumentError);

  assert.equal(transport.callsOf("StartDiff").length, 0);
});

test("a finished diff carrying an error rejects with its class", async () => {
  const transport = engine().always("Poll", () => finishedWithError("config", "the configuration is invalid"));
  const config = await open(transport);

  await assert.rejects(config.diff("main.xcl"), ConfigError);
});

// load

test("load returns a promise that resolves once the operation is finished", async () => {
  const transport = engine();
  const config = await open(transport);

  const pending = config.load();

  assert.ok(pending instanceof Promise);
  assert.equal(await pending, undefined);
  assert.equal(transport.callsOf("Poll").length, 1);
});

test("load sends StartLoad on the configuration's handle", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.load();

  assert.equal(onlyCall(transport, "StartLoad").handle, HANDLE);
});

test("a finished load carrying an error rejects with its class", async () => {
  const transport = engine().always("Poll", () => finishedWithError("invalid_saved_data", "the state could not be read"));
  const config = await open(transport);

  await assert.rejects(config.load(), InvalidSavedDataError);
});

// destroy

test("destroy returns a promise that resolves once the operation is finished", async () => {
  const transport = engine();
  const config = await open(transport);

  const pending = config.destroy();

  assert.ok(pending instanceof Promise);
  assert.equal(await pending, undefined);
  assert.equal(transport.callsOf("Poll").length, 1);
});

test("destroy sends StartDestroy on the configuration's handle", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.destroy();

  assert.equal(onlyCall(transport, "StartDestroy").handle, HANDLE);
});

test("a finished destroy carrying an error rejects with its class", async () => {
  const transport = engine().always("Poll", () => finishedWithError("provider", "the provider failed"));
  const config = await open(transport);

  await assert.rejects(config.destroy(), ProviderError);
});

// polling

test("an operation keeps polling while polls answer no task", async () => {
  const transport = engine().queue(
    "Poll",
    () => noTask(),
    () => noTask(),
    () => finished(),
  );
  const config = await open(transport);

  await config.apply("main.xcl");

  assert.equal(transport.callsOf("Poll").length, 3);
});

test("an operation keeps polling past an event task", async () => {
  const transport = engine().queue(
    "Poll",
    () => eventTask(),
    () => finished(),
  );
  const config = await open(transport);

  await config.apply("main.xcl");

  assert.equal(transport.callsOf("Poll").length, 2);
});

test("a poll is sent on the configuration's handle", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.apply("main.xcl");

  assert.equal(onlyCall(transport, "Poll").handle, HANDLE);
});

test("a poll waits in the engine for one second", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.apply("main.xcl");

  assert.equal(POLL_WAIT_MS, 1000);
  assert.equal(fromBinary(PollRequestSchema, onlyCall(transport, "Poll").request).waitMs, 1000);
});

test("an operation's start refused by the engine rejects with its class", async () => {
  const transport = engine().always("StartApply", () => failed("operation_in_progress", "the engine is busy"));
  const config = await open(transport);

  await assert.rejects(config.apply("main.xcl"), OperationInProgressError);
  assert.equal(transport.callsOf("Poll").length, 0);
});

test("a poll refused by the engine rejects with its class", async () => {
  const transport = engine().always("Poll", () => failed("internal", "it failed"));
  const config = await open(transport);

  await assert.rejects(config.apply("main.xcl"), (error: unknown) => {
    assert.ok(error instanceof InternalError);
    assert.equal(error.message, "it failed");
    return true;
  });
});

// one operation at a time

test("apply while validate runs rejects with OperationInProgressError", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.validate("main.xcl");
  await held.reached;

  await assert.rejects(config.apply("main.xcl"), OperationInProgressError);

  held.finish(finished());
  await first;
});

test("diff while apply runs rejects with OperationInProgressError", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.apply("main.xcl");
  await held.reached;

  await assert.rejects(config.diff("main.xcl"), OperationInProgressError);

  held.finish(finished());
  await first;
});

test("load while diff runs rejects with OperationInProgressError", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.diff("main.xcl");
  await held.reached;

  await assert.rejects(config.load(), OperationInProgressError);

  held.finish(finishedWithDiff({}));
  await first;
});

test("destroy while load runs rejects with OperationInProgressError", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.load();
  await held.reached;

  await assert.rejects(config.destroy(), OperationInProgressError);

  held.finish(finished());
  await first;
});

test("validate while destroy runs rejects with OperationInProgressError", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.destroy();
  await held.reached;

  await assert.rejects(config.validate("main.xcl"), OperationInProgressError);

  held.finish(finished());
  await first;
});

test("the same operation twice rejects with OperationInProgressError", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.apply("main.xcl");
  await held.reached;

  await assert.rejects(config.apply("main.xcl"), OperationInProgressError);

  held.finish(finished());
  await first;
});

test("a refused operation never reaches the engine", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.validate("main.xcl");
  await held.reached;
  await assert.rejects(config.apply("main.xcl"), OperationInProgressError);

  assert.equal(transport.callsOf("StartApply").length, 0);

  held.finish(finished());
  await first;
});

test("an operation is refused while the first is still starting", async () => {
  const transport = engine();
  let answerStart!: (result: CallResult) => void;
  const startAnswer = new Promise<CallResult>((resolve) => {
    answerStart = resolve;
  });
  transport.always("StartValidate", () => startAnswer);
  const config = await open(transport);

  const first = config.validate("main.xcl");

  await assert.rejects(config.apply("main.xcl"), OperationInProgressError);

  answerStart(started());
  await first;
});

test("the first operation still finishes after a second is refused", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.apply("main.xcl");
  await held.reached;
  await assert.rejects(config.apply("main.xcl"), OperationInProgressError);

  held.finish(finished());

  assert.equal(await first, undefined);
});

test("an operation after the first has ended works", async () => {
  const transport = engine();
  const held = holdPoll(transport);
  const config = await open(transport);

  const first = config.validate("main.xcl");
  await held.reached;
  held.finish(finished());
  await first;

  transport.always("Poll", () => finished());
  await config.apply("main.xcl");

  assert.equal(transport.callsOf("StartApply").length, 1);
});

test("an operation after one that finished with an error works", async () => {
  const transport = engine().queue(
    "Poll",
    () => finishedWithError("config", "the configuration is invalid"),
    () => finished(),
  );
  const config = await open(transport);

  await assert.rejects(config.validate("main.xcl"), ConfigError);
  await config.apply("main.xcl");

  assert.equal(transport.callsOf("StartApply").length, 1);
});

test("an operation after a refused start works", async () => {
  const transport = engine().queue(
    "StartValidate",
    () => failed("config", "the configuration is invalid"),
    () => started(),
  );
  const config = await open(transport);

  await assert.rejects(config.validate("main.xcl"), ConfigError);
  await config.validate("main.xcl");

  assert.equal(transport.callsOf("StartValidate").length, 2);
});

test("an operation after a refused poll works", async () => {
  const transport = engine().queue(
    "Poll",
    () => failed("internal", "it failed"),
    () => finished(),
  );
  const config = await open(transport);

  await assert.rejects(config.apply("main.xcl"), InternalError);
  await config.validate("main.xcl");

  assert.equal(transport.callsOf("StartValidate").length, 1);
});

test("an operation with no paths does not hold up the next", async () => {
  const transport = engine();
  const config = await open(transport);

  await assert.rejects(config.apply([]), InvalidArgumentError);
  await config.apply("main.xcl");

  assert.equal(transport.callsOf("StartApply").length, 1);
});

test("two configurations run their operations independently", async () => {
  const transport = engine().queue(
    "CreateConfig",
    () => ok(CreateConfigResponseSchema, { handle: 1n }),
    () => ok(CreateConfigResponseSchema, { handle: 2n }),
  );
  let firstPollReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    firstPollReached = resolve;
  });
  let answerFirstPoll!: (result: CallResult) => void;
  const firstPollAnswer = new Promise<CallResult>((resolve) => {
    answerFirstPoll = resolve;
  });
  transport.queue(
    "Poll",
    () => {
      firstPollReached();
      return firstPollAnswer;
    },
    () => finished(),
  );
  const client = new Client(transport);
  const firstConfig = await createConfigWith(client, {});
  const secondConfig = await createConfigWith(client, {});

  const first = firstConfig.apply("first.xcl");
  await reached;

  await secondConfig.apply("second.xcl");

  answerFirstPoll(finished());
  await first;
  assert.deepEqual(
    transport.callsOf("StartApply").map((call) => call.handle),
    [1n, 2n],
  );
});

// lookups

test("find sends the address on the configuration's handle", async () => {
  const transport = engine().always("Find", () => entityResponse({ meta: { name: "web" } }));
  const config = await open(transport);

  await config.find("resource.container.web");

  const call = onlyCall(transport, "Find");
  assert.equal(call.handle, HANDLE);
  assert.equal(fromBinary(FindRequestSchema, call.request).address, "resource.container.web");
});

test("find exposes the entity's metadata", async () => {
  const transport = engine().always("Find", () =>
    entityResponse({
      meta: {
        id: "module.db.resource.container.web",
        name: "web",
        type: "resource",
        subtype: "container",
        module: "db",
        file: "main.xcl",
        line: 3,
        column: 1,
        status: "created",
        links: ["resource.network.main"],
        references: { network_id: "resource.network.main.id" },
      },
      disabled: true,
      depends_on: ["resource.network.main"],
    }),
  );
  const config = await open(transport);

  const entity = await config.find("module.db.resource.container.web");

  assert.deepEqual(entity.meta, {
    id: "module.db.resource.container.web",
    name: "web",
    type: "resource",
    subtype: "container",
    module: "db",
    file: "main.xcl",
    line: 3,
    column: 1,
    status: "created",
    links: ["resource.network.main"],
    references: { network_id: "resource.network.main.id" },
    disabled: true,
    dependsOn: ["resource.network.main"],
    extra: {},
  });
});

test("an entity the engine recorded nothing about has empty metadata", async () => {
  const transport = engine().always("Find", () => entityResponse({}));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.meta, {
    id: "",
    name: "",
    type: "",
    subtype: "",
    module: "",
    file: "",
    line: 0,
    column: 0,
    status: "",
    links: [],
    references: {},
    disabled: false,
    dependsOn: [],
    extra: {},
  });
});

test("metadata the package does not know is kept in extra", async () => {
  const transport = engine().always("Find", () => entityResponse({ meta: { name: "web", custom_key: "kept" } }));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.meta.extra, { custom_key: "kept" });
});

test("attributes have camelCase top-level names", async () => {
  const transport = engine().always("Find", () => entityResponse({ meta: { name: "web" }, container_image: "nginx", host_port: 8080, image: "nginx:1.27" }));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.attributes, { containerImage: "nginx", hostPort: 8080, image: "nginx:1.27" });
});

test("attributes leave out what the engine records beside them", async () => {
  const transport = engine().always("Find", () => entityResponse({ meta: { name: "web" }, disabled: true, depends_on: ["resource.network.main"], image: "nginx" }));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.attributes, { image: "nginx" });
});

test("a nested map's upper-case keys stay as the engine wrote them", async () => {
  const transport = engine().always("Find", () => entityResponse({ env_vars: { LOG_LEVEL: "debug" } }));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.attributes.envVars, { LOG_LEVEL: "debug" });
});

test("a nested map's snake_case keys stay as the engine wrote them", async () => {
  const transport = engine().always("Find", () => entityResponse({ env_vars: { some_key: "value" } }));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.attributes.envVars, { some_key: "value" });
});

test("objects inside a list keep their keys as the engine wrote them", async () => {
  const transport = engine().always("Find", () => entityResponse({ port_mappings: [{ host_port: 8080 }] }));
  const config = await open(transport);

  const entity = await config.find("resource.container.web");

  assert.deepEqual(entity.attributes.portMappings, [{ host_port: 8080 }]);
});

test("findByType sends the segments and returns each entity", async () => {
  const transport = engine().always("FindByType", () => entitiesResponse({ meta: { name: "one" }, host_port: 1 }, { meta: { name: "two" }, host_port: 2 }));
  const config = await open(transport);

  const entities = await config.findByType("resource", "container");

  const call = onlyCall(transport, "FindByType");
  assert.equal(call.handle, HANDLE);
  assert.deepEqual(fromBinary(FindByTypeRequestSchema, call.request).path, ["resource", "container"]);
  assert.deepEqual(
    entities.map((entity) => entity.meta.name),
    ["one", "two"],
  );
  assert.deepEqual(
    entities.map((entity) => entity.attributes.hostPort),
    [1, 2],
  );
});

test("findByType with no matches returns an empty list", async () => {
  const transport = engine().always("FindByType", () => entitiesResponse());
  const config = await open(transport);

  assert.deepEqual(await config.findByType("resource", "container"), []);
});

test("findOne sends the segments and returns the entity", async () => {
  const transport = engine().always("FindOne", () => entityResponse({ meta: { name: "web" }, host_port: 8080 }));
  const config = await open(transport);

  const entity = await config.findOne("resource", "container");

  const call = onlyCall(transport, "FindOne");
  assert.equal(call.handle, HANDLE);
  assert.deepEqual(fromBinary(FindByTypeRequestSchema, call.request).path, ["resource", "container"]);
  assert.equal(entity.meta.name, "web");
  assert.equal(entity.attributes.hostPort, 8080);
});

test("entities returns every entity", async () => {
  const transport = engine().always("Entities", () => entitiesResponse({ meta: { name: "one" } }, { meta: { name: "two" } }));
  const config = await open(transport);

  const entities = await config.entities();

  assert.equal(onlyCall(transport, "Entities").handle, HANDLE);
  assert.deepEqual(
    (entities as Entity[]).map((entity) => entity.meta.name),
    ["one", "two"],
  );
});

test("entityCount counts the entities", async () => {
  const transport = engine().always("Entities", () => entitiesResponse({ meta: { name: "one" } }, { meta: { name: "two" } }, { meta: { name: "three" } }));
  const config = await open(transport);

  assert.equal(await config.entityCount(), 3);
});

test("entityCount is zero when there are no entities", async () => {
  const transport = engine().always("Entities", () => entitiesResponse());
  const config = await open(transport);

  assert.equal(await config.entityCount(), 0);
});

test("outputs are a plain object keyed by address", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, { outputsJson: json({ "output.image": "nginx" }) }));
  const config = await open(transport);

  const outputs = await config.outputs();

  assert.equal(Object.getPrototypeOf(outputs), Object.prototype);
  assert.deepEqual(outputs, { "output.image": "nginx" });
  assert.equal(onlyCall(transport, "Outputs").handle, HANDLE);
});

test("an output's name is converted", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, { outputsJson: json({ "output.my_value": 1 }) }));
  const config = await open(transport);

  assert.deepEqual(await config.outputs(), { "output.myValue": 1 });
});

test("only a module output's last segment is converted", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, { outputsJson: json({ "module.my_db.output.my_value": 1 }) }));
  const config = await open(transport);

  assert.deepEqual(await config.outputs(), { "module.my_db.output.myValue": 1 });
});

test("module.db.output.my_value becomes module.db.output.myValue", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, { outputsJson: json({ "module.db.output.my_value": 1 }) }));
  const config = await open(transport);

  assert.deepEqual(await config.outputs(), { "module.db.output.myValue": 1 });
});

test("an output's value keeps its keys as the engine wrote them", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, { outputsJson: json({ "output.my_value": { some_key: "value", LOG_LEVEL: "debug" } }) }));
  const config = await open(transport);

  assert.deepEqual(await config.outputs(), { "output.myValue": { some_key: "value", LOG_LEVEL: "debug" } });
});

test("no outputs JSON gives an empty object", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, {}));
  const config = await open(transport);

  assert.deepEqual(await config.outputs(), {});
});

test("an empty outputs object gives an empty object", async () => {
  const transport = engine().always("Outputs", () => ok(OutputsResponseSchema, { outputsJson: json({}) }));
  const config = await open(transport);

  assert.deepEqual(await config.outputs(), {});
});

test("find of an address nothing holds rejects with NotFoundError", async () => {
  const transport = engine().always("Find", () => failed("not_found", "no entity at resource.container.web"));
  const config = await open(transport);

  await assert.rejects(config.find("resource.container.web"), NotFoundError);
});

test("findOne of a type nothing holds rejects with NotFoundError", async () => {
  const transport = engine().always("FindOne", () => failed("not_found", "no entity of that type"));
  const config = await open(transport);

  await assert.rejects(config.findOne("resource", "container"), NotFoundError);
});

test("findOne of a type held more than once rejects with NotUniqueError", async () => {
  const transport = engine().always("FindOne", () => failed("not_unique", "two entities of that type"));
  const config = await open(transport);

  await assert.rejects(config.findOne("resource", "container"), NotUniqueError);
});

test("findByType of a type nothing declares rejects with its class", async () => {
  const transport = engine().always("FindByType", () => failed("unknown_type", "nothing declares resource"));
  const config = await open(transport);

  await assert.rejects(config.findByType("resource"), UnknownTypeError);
});

// closing

test("close releases the configuration's handle", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.close();

  assert.deepEqual(transport.released, [HANDLE]);
});

test("closing twice releases once", async () => {
  const transport = engine();
  const config = await open(transport);

  await config.close();
  await config.close();

  assert.deepEqual(transport.released, [HANDLE]);
});

test("closing twice at once releases once", async () => {
  const transport = engine();
  const config = await open(transport);

  await Promise.all([config.close(), config.close()]);

  assert.deepEqual(transport.released, [HANDLE]);
});

test("a release the engine refuses rejects with the binding error", async () => {
  const transport = engine();
  transport.releaseStatus = -3;
  const config = await open(transport);

  await assert.rejects(config.close(), InternalBindingError);
});

test("await using releases the configuration when the block ends", async () => {
  const transport = engine();

  {
    await using config = await open(transport);
    assert.equal(transport.released.length, 0);
    assert.ok(config !== undefined);
  }

  assert.deepEqual(transport.released, [HANDLE]);
});

test("await using releases the configuration when the block throws", async () => {
  const transport = engine();

  await assert.rejects(async () => {
    await using config = await open(transport);
    assert.ok(config !== undefined);
    throw new Error("the block failed");
  }, /the block failed/);

  assert.deepEqual(transport.released, [HANDLE]);
});

test("await using after close releases once", async () => {
  const transport = engine();

  {
    await using config = await open(transport);
    await config.close();
  }

  assert.deepEqual(transport.released, [HANDLE]);
});

test("validate after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.validate("main.xcl"), InvalidArgumentError);

  assert.equal(transport.callsOf("StartValidate").length, 0);
});

test("apply after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.apply("main.xcl"), InvalidArgumentError);

  assert.equal(transport.callsOf("StartApply").length, 0);
});

test("diff after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.diff("main.xcl"), InvalidArgumentError);

  assert.equal(transport.callsOf("StartDiff").length, 0);
});

test("load after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.load(), InvalidArgumentError);

  assert.equal(transport.callsOf("StartLoad").length, 0);
});

test("destroy after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.destroy(), InvalidArgumentError);

  assert.equal(transport.callsOf("StartDestroy").length, 0);
});

test("find after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.find("resource.container.web"), InvalidArgumentError);

  assert.equal(transport.callsOf("Find").length, 0);
});

test("findByType after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.findByType("resource", "container"), InvalidArgumentError);

  assert.equal(transport.callsOf("FindByType").length, 0);
});

test("findOne after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.findOne("resource", "container"), InvalidArgumentError);

  assert.equal(transport.callsOf("FindOne").length, 0);
});

test("entities after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.entities(), InvalidArgumentError);

  assert.equal(transport.callsOf("Entities").length, 0);
});

test("entityCount after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.entityCount(), InvalidArgumentError);

  assert.equal(transport.callsOf("Entities").length, 0);
});

test("outputs after close rejects with InvalidArgumentError", async () => {
  const transport = engine();
  const config = await open(transport);
  await config.close();

  await assert.rejects(config.outputs(), InvalidArgumentError);

  assert.equal(transport.callsOf("Outputs").length, 0);
});
