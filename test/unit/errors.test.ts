import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import * as errors from "../../src/errors.js";
import { fromProto, XclError } from "../../src/errors.js";
import { ErrorSchema } from "../../src/internal/core/xcl/core/v1/core_pb.js";

function engineError(code: string, message = "it failed"): ReturnType<typeof create<typeof ErrorSchema>> {
  return create(ErrorSchema, { code, message });
}

test("not_found maps to NotFoundError", () => {
  const error = fromProto(engineError("not_found"));
  assert.ok(error instanceof errors.NotFoundError);
  assert.ok(error instanceof XclError);
  assert.equal(error.code, "not_found");
});

test("not_unique maps to NotUniqueError", () => {
  const error = fromProto(engineError("not_unique"));
  assert.ok(error instanceof errors.NotUniqueError);
  assert.ok(error instanceof XclError);
});

test("unknown_type maps to UnknownTypeError", () => {
  assert.ok(fromProto(engineError("unknown_type")) instanceof errors.UnknownTypeError);
});

test("not_typeable maps to NotTypeableError", () => {
  assert.ok(fromProto(engineError("not_typeable")) instanceof errors.NotTypeableError);
});

test("not_registered maps to NotRegisteredError", () => {
  assert.ok(fromProto(engineError("not_registered")) instanceof errors.NotRegisteredError);
});

test("type_mismatch maps to TypeMismatchError", () => {
  assert.ok(fromProto(engineError("type_mismatch")) instanceof errors.TypeMismatchError);
});

test("not_an_entity maps to NotAnEntityError", () => {
  assert.ok(fromProto(engineError("not_an_entity")) instanceof errors.NotAnEntityError);
});

test("type_name_clash maps to TypeNameClashError", () => {
  assert.ok(fromProto(engineError("type_name_clash")) instanceof errors.TypeNameClashError);
});

test("type_form maps to TypeFormError", () => {
  assert.ok(fromProto(engineError("type_form")) instanceof errors.TypeFormError);
});

test("invalid_type maps to InvalidTypeError", () => {
  assert.ok(fromProto(engineError("invalid_type")) instanceof errors.InvalidTypeError);
});

test("function_name_clash maps to FunctionNameClashError", () => {
  assert.ok(fromProto(engineError("function_name_clash")) instanceof errors.FunctionNameClashError);
});

test("invalid_function maps to InvalidFunctionError", () => {
  assert.ok(fromProto(engineError("invalid_function")) instanceof errors.InvalidFunctionError);
});

test("plugin_load maps to PluginLoadError", () => {
  assert.ok(fromProto(engineError("plugin_load")) instanceof errors.PluginLoadError);
});

test("plugin_not_found maps to PluginNotFoundError", () => {
  assert.ok(fromProto(engineError("plugin_not_found")) instanceof errors.PluginNotFoundError);
});

test("plugin_verification maps to PluginVerificationError", () => {
  assert.ok(fromProto(engineError("plugin_verification")) instanceof errors.PluginVerificationError);
});

test("empty_configuration maps to EmptyConfigurationError", () => {
  assert.ok(fromProto(engineError("empty_configuration")) instanceof errors.EmptyConfigurationError);
});

test("unregistered_type maps to UnregisteredTypeError", () => {
  assert.ok(fromProto(engineError("unregistered_type")) instanceof errors.UnregisteredTypeError);
});

test("invalid_saved_data maps to InvalidSavedDataError", () => {
  assert.ok(fromProto(engineError("invalid_saved_data")) instanceof errors.InvalidSavedDataError);
});

test("not_encodable maps to NotEncodableError", () => {
  assert.ok(fromProto(engineError("not_encodable")) instanceof errors.NotEncodableError);
});

test("unrecoverable maps to UnrecoverableError", () => {
  assert.ok(fromProto(engineError("unrecoverable")) instanceof errors.UnrecoverableError);
});

test("mask_not_reversible maps to MaskNotReversibleError", () => {
  assert.ok(fromProto(engineError("mask_not_reversible")) instanceof errors.MaskNotReversibleError);
});

test("invalid_theme maps to InvalidThemeError", () => {
  assert.ok(fromProto(engineError("invalid_theme")) instanceof errors.InvalidThemeError);
});

test("config maps to ConfigError", () => {
  assert.ok(fromProto(engineError("config")) instanceof errors.ConfigError);
});

test("provider maps to ProviderError", () => {
  assert.ok(fromProto(engineError("provider")) instanceof errors.ProviderError);
});

test("cancelled maps to CancelledError", () => {
  assert.ok(fromProto(engineError("cancelled")) instanceof errors.CancelledError);
});

test("operation_in_progress maps to OperationInProgressError", () => {
  assert.ok(fromProto(engineError("operation_in_progress")) instanceof errors.OperationInProgressError);
});

test("invalid_argument maps to InvalidArgumentError", () => {
  assert.ok(fromProto(engineError("invalid_argument")) instanceof errors.InvalidArgumentError);
});

test("internal maps to InternalError", () => {
  assert.ok(fromProto(engineError("internal")) instanceof errors.InternalError);
});

test("an unknown code becomes the base class and keeps its code", () => {
  const error = fromProto(engineError("something_new", "from a later engine"));

  assert.equal(error.constructor, XclError);
  assert.equal(error.code, "something_new");
  assert.equal(error.message, "from a later engine");
});

test("a configuration error lists each problem with its position and names", () => {
  const error = fromProto(
    create(ErrorSchema, {
      code: "config",
      message: "the configuration is invalid",
      causes: [
        create(ErrorSchema, {
          code: "config",
          message: "missing image",
          details: { file: "main.xcl", line: "3", column: "7", summary: "Missing required argument", detail: "image is required", entity: "app.web", field: "image" },
        }),
        create(ErrorSchema, { code: "config", message: "bad port", details: { file: "other.xcl", line: "9", column: "1" } }),
      ],
    }),
  );

  assert.ok(error instanceof errors.ConfigError);
  assert.deepEqual(error.problems, [
    { file: "main.xcl", line: 3, column: 7, summary: "Missing required argument", detail: "image is required", entity: "app.web", field: "image" },
    { file: "other.xcl", line: 9, column: 1, summary: "bad port", detail: "", entity: "", field: "" },
  ]);
});

test("a configuration error with its own position is its one problem", () => {
  const error = fromProto(create(ErrorSchema, { code: "config", message: "broken", details: { file: "main.xcl", line: "2", column: "4" } }));

  assert.equal(error.problems.length, 1);
  assert.equal(error.problems[0]?.file, "main.xcl");
  assert.equal(error.problems[0]?.line, 2);
});

test("an error's code, message, details and problems are enumerable", () => {
  const error = fromProto(create(ErrorSchema, { code: "not_found", message: "no such entity", details: { address: "app.web" } }));

  const keys = Object.keys(error);

  assert.ok(keys.includes("code"));
  assert.ok(keys.includes("message"));
  assert.ok(keys.includes("details"));
  assert.ok(keys.includes("problems"));
  assert.deepEqual(JSON.parse(JSON.stringify(error)).details, { address: "app.web" });
  assert.equal(JSON.parse(JSON.stringify(error)).message, "no such entity");
});

test("an engine-exited error carries the signal", () => {
  const error = new errors.EngineExitedError(null, "SIGKILL");

  assert.ok(error instanceof XclError);
  assert.equal(error.code, "engine_exited");
  assert.equal(error.signal, "SIGKILL");
  assert.equal(error.exitCode, null);
  assert.match(error.message, /SIGKILL/);
});

test("an engine-exited error carries the exit status", () => {
  const error = new errors.EngineExitedError(3, null);

  assert.equal(error.exitCode, 3);
  assert.equal(error.signal, null);
  assert.match(error.message, /status 3/);
});

test("an engine-version error names both versions", () => {
  const error = new errors.EngineVersionError("wrong engine", "v1.0.0", "v2.0.0");

  assert.equal(error.expected, "v1.0.0");
  assert.equal(error.engine, "v2.0.0");
  assert.equal(error.code, "engine_version");
});

test("an internal binding error names the method and status", () => {
  const error = new errors.InternalBindingError("Poll", -3);

  assert.equal(error.status, -3);
  assert.match(error.message, /Poll/);
  assert.match(error.message, /unknown or released handle/);
});
