import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary } from "@bufbuild/protobuf";

import { createConfigWith } from "../../src/config.js";
import { Attribute } from "../../src/decorators.js";
import { Entity, Meta } from "../../src/entity.js";
import { NotFoundError } from "../../src/errors.js";
import { Event, EventDataLevel } from "../../src/events.js";
import { ClassMap, GenericEntity } from "../../src/hydrate.js";
import { Client } from "../../src/internal/client.js";
import {
  CreateConfigRequestSchema,
  CreateConfigResponseSchema,
  ErrorSchema,
  EventDataLevel as EventDataLevelMessage,
  EventSchema,
  PollResponseSchema,
  StartOperationResponseSchema,
} from "../../src/internal/core/xcl/core/v1/core_pb.js";
import { registrationOf } from "../../src/schema.js";
import { FakeTransport, ok } from "../helpers/fake-transport.js";

@Entity("app")
class App {
  @Meta() meta!: Meta;
  @Attribute(String) image!: string;
}

const classes = new ClassMap([registrationOf(App)]);
const encoder = new TextEncoder();

function eventTask(resourceId: string): ReturnType<typeof ok> {
  return ok(PollResponseSchema, { task: { case: "event", value: create(EventSchema, { operation: "create", phase: "start", resourceId }) } });
}

function finished(): ReturnType<typeof ok> {
  return ok(PollResponseSchema, { task: { case: "finished", value: { operationId: 1n } } });
}

function engine(): FakeTransport {
  return new FakeTransport()
    .always("CreateConfig", () => ok(CreateConfigResponseSchema, { handle: 7n }))
    .always("StartApply", () => ok(StartOperationResponseSchema, { operationId: 1n }));
}

const appData = encoder.encode(JSON.stringify({ meta: { id: "app.web", name: "web", type: "app" }, image: "nginx" }));

test("an event carries the fields of Go's event", () => {
  const event = new Event(
    create(EventSchema, {
      timeUnixNano: 1_500_000_000n,
      source: "core",
      operation: "create",
      phase: "success",
      resourceType: "app",
      resourceId: "app.web",
      file: "main.xcl",
      durationNano: 2_500_000n,
    }),
    classes,
  );

  assert.equal(event.time.getTime(), 1500);
  assert.equal(event.source, "core");
  assert.equal(event.operation, "create");
  assert.equal(event.phase, "success");
  assert.equal(event.resourceType, "app");
  assert.equal(event.resourceId, "app.web");
  assert.equal(event.file, "main.xcl");
  assert.equal(event.duration, 2.5);
});

test("a failed step's error is its error class", () => {
  const event = new Event(create(EventSchema, { error: create(ErrorSchema, { code: "not_found", message: "gone" }) }), classes);

  assert.ok(event.error instanceof NotFoundError);
});

test("an event with no data has undefined data", () => {
  assert.equal(new Event(create(EventSchema, {}), classes).data, undefined);
});

test("an event's entity is undefined when it carries no data", () => {
  assert.equal(new Event(create(EventSchema, {}), classes).entity(App), undefined);
});

test("an event's entity is an instance of the class asked for", () => {
  const entity = new Event(create(EventSchema, { data: appData }), classes).entity(App);

  assert.ok(entity instanceof App);
  assert.equal(entity.image, "nginx");
});

test("an event's entity with no class is the registered instance", () => {
  assert.ok(new Event(create(EventSchema, { data: appData }), classes).entity() instanceof App);
});

test("an event's entity of an unregistered type is generic", () => {
  const data = encoder.encode(JSON.stringify({ meta: { id: "docker.network.main", name: "main", type: "docker" } }));

  assert.ok(new Event(create(EventSchema, { data }), classes).entity() instanceof GenericEntity);
});

test("a log event exposes its level and message", () => {
  const event = new Event(create(EventSchema, { metaJson: encoder.encode(JSON.stringify({ level: "warn", message: "careful" })) }), classes);

  assert.equal(event.level, "warn");
  assert.equal(event.message, "careful");
});

test("unparseable metadata is kept as raw text", () => {
  const event = new Event(create(EventSchema, { metaJson: encoder.encode("not json") }), classes);

  assert.deepEqual(event.meta, { raw: "not json" });
});

test("events reach the handler in order", async () => {
  const seen: string[] = [];
  const transport = engine().queue("Poll", () => eventTask("a"), () => eventTask("b"), () => eventTask("c"), finished);
  const config = await createConfigWith(new Client(transport), { onEvent: (event) => void seen.push(event.resourceId) });

  await config.apply("/x");

  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("an async handler is awaited before the next event", async () => {
  const seen: string[] = [];
  const transport = engine().queue("Poll", () => eventTask("a"), () => eventTask("b"), finished);
  const config = await createConfigWith(new Client(transport), {
    onEvent: async (event) => {
      seen.push(`start ${event.resourceId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(`end ${event.resourceId}`);
    },
  });

  await config.apply("/x");

  assert.deepEqual(seen, ["start a", "end a", "start b", "end b"]);
});

test("the operation does not settle until every handler has finished", async () => {
  let handled = false;
  const transport = engine().queue("Poll", () => eventTask("a"), finished);
  const config = await createConfigWith(new Client(transport), {
    onEvent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      handled = true;
    },
  });

  await config.apply("/x");

  assert.equal(handled, true);
});

test("a handler's exception becomes a warning and the operation carries on", async (t) => {
  const warnings: string[] = [];
  const listener = (warning: Error): void => {
    warnings.push(warning.message);
  };
  process.on("warning", listener);
  t.after(() => process.off("warning", listener));
  const seen: string[] = [];
  const transport = engine().queue("Poll", () => eventTask("a"), () => eventTask("b"), finished);
  const config = await createConfigWith(new Client(transport), {
    onEvent: (event) => {
      seen.push(event.resourceId);
      if (event.resourceId === "a") {
        throw new Error("the handler broke");
      }
    },
  });

  await config.apply("/x");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ["a", "b"]);
  assert.ok(warnings.some((warning) => warning.includes("the handler broke")));
});

test("creating with a handler asks for events", async () => {
  const transport = engine();

  await createConfigWith(new Client(transport), { onEvent: () => {} });

  assert.equal(fromBinary(CreateConfigRequestSchema, transport.callsOf("CreateConfig")[0]?.request as Uint8Array).events, true);
});

test("creating with no handler asks for none", async () => {
  const transport = engine();

  await createConfigWith(new Client(transport), {});

  assert.equal(fromBinary(CreateConfigRequestSchema, transport.callsOf("CreateConfig")[0]?.request as Uint8Array).events, false);
});

test("the data level and buffer size reach the engine", async () => {
  const transport = engine();

  await createConfigWith(new Client(transport), { onEvent: () => {}, eventData: EventDataLevel.Processed, eventBufferSize: 32 });

  const request = fromBinary(CreateConfigRequestSchema, transport.callsOf("CreateConfig")[0]?.request as Uint8Array);
  assert.equal(request.eventData, EventDataLevelMessage.EVENT_DATA_PROCESSED);
  assert.equal(request.eventBufferSize, 32);
});
