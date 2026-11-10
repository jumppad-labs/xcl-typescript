/**
 * Registries: where a configuration's plugins come from. They are plain
 * builders that hold no engine state: register what the configuration may use,
 * then pass the registry to `createConfig`.
 */

import type { MessageInitShape } from "@bufbuild/protobuf";

import { functionSpecOf, type EntityClass } from "./decorators.js";
import { SchemaError } from "./errors.js";
import type { DeclaredTypeSchema, RegistrySchema } from "./internal/core/xcl/core/v1/core_pb.js";
import { registrationOf, signatureOf, type Registration } from "./schema.js";

/** A registry as `CreateConfig` carries it. @internal */
export type RegistryMessage = MessageInitShape<typeof RegistrySchema>;

function declaredType(registration: Registration): MessageInitShape<typeof DeclaredTypeSchema> {
  return {
    type: registration.type,
    subtype: registration.subtype,
    schema: new TextEncoder().encode(JSON.stringify(registration.schema)),
  };
}

/** A function offered to configuration. @internal */
export interface RegisteredFunction {
  name: string;
  signature: Record<string, unknown>;
  call: (...args: unknown[]) => unknown;
}

/** Anything a configuration takes as a registry. */
export interface Registry {
  /** The block types this registry declares, in order. @internal */
  readonly registrations: readonly Registration[];
  /** The functions this registry offers, in order. @internal */
  readonly functions: readonly RegisteredFunction[];
  /** The registry as `CreateConfig` carries it. @internal */
  toProto(): RegistryMessage;
}

/** What a `LocalRegistry` can be built with. */
export interface LocalRegistryOptions {
  /** The files a plugin directory is searched for, such as `xcl-plugin-*`; left out, the engine's default applies. */
  pluginPattern?: string;
}

/** Plugins the program itself provides. */
export class LocalRegistry implements Registry {
  readonly #pluginPattern: string;
  readonly #externalPlugins: string[][] = [];
  readonly #pluginDirectories: string[] = [];
  readonly #registrations: Registration[] = [];
  readonly #functions: RegisteredFunction[] = [];

  constructor(options: LocalRegistryOptions = {}) {
    this.#pluginPattern = options.pluginPattern ?? "";
  }

  /**
   * Declares decorated entity classes as block types. Each class is constructed
   * once, and anything wrong with its definition throws `SchemaError` here.
   */
  register(...classes: EntityClass[]): void {
    this.#registrations.push(...classes.map(registrationOf));
  }

  /** The block types this registry declares, in order. @internal */
  get registrations(): readonly Registration[] {
    return this.#registrations;
  }

  /**
   * Offers every `@Func` method of `instance` to configuration, bound to it. A
   * name a builtin or another function uses is refused when the configuration
   * is created.
   */
  registerFunctions(instance: object): void {
    const seen = new Set<string>();
    for (let proto = Object.getPrototypeOf(instance); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const property of Object.getOwnPropertyNames(proto)) {
        if (seen.has(property)) {
          continue;
        }
        seen.add(property);
        const method = Object.getOwnPropertyDescriptor(proto, property)?.value as ((...args: unknown[]) => unknown) | undefined;
        const spec = functionSpecOf(method);
        if (method !== undefined && spec !== undefined) {
          this.#functions.push({ name: spec.name, signature: signatureOf(spec, `function ${spec.name}`), call: method.bind(instance) });
        }
      }
    }
  }

  /** The functions this registry offers, in order. @internal */
  get functions(): readonly RegisteredFunction[] {
    return this.#functions;
  }

  /**
   * Uses the external plugin that `command` starts: a plugin binary's path, or
   * an array holding a program and its arguments.
   */
  registerExternalPlugin(command: string | readonly string[]): void {
    const words = typeof command === "string" ? [command] : [...command];
    if (words.length === 0) {
      throw new SchemaError("registerExternalPlugin needs a command: a plugin's path, or an array holding a program and its arguments");
    }
    this.#externalPlugins.push(words);
  }

  /** Uses every plugin binary found in the directory at `path`. The engine expands a leading `~/`. */
  registerPluginDirectory(path: string): void {
    this.#pluginDirectories.push(path);
  }

  /** The registry as `CreateConfig` carries it. @internal */
  toProto(): RegistryMessage {
    return {
      kind: {
        case: "local",
        value: {
          pluginPattern: this.#pluginPattern,
          types: this.#registrations.map(declaredType),
          functions: this.#functions.map(({ name, signature }) => ({ name, signature: new TextEncoder().encode(JSON.stringify(signature)) })),
          externalPluginCommands: this.#externalPlugins.map((command) => ({ command })),
          pluginDirectories: [...this.#pluginDirectories],
        },
      },
    };
  }
}

/** What a `GitHubRegistry` can be built with. */
export interface GitHubRegistryOptions {
  /** The armoured public keys a release's signature must verify against. */
  trustedKeys?: readonly string[];
  /** Where releases are installed. */
  cacheDir?: string;
  /** A GitHub token, for private repositories or a higher rate limit. */
  token?: string;
  /** The API to read releases from, for a GitHub Enterprise host or a test server. */
  apiUrl?: string;
}

/** Plugins published as signed GitHub releases, installed on first use. */
export class GitHubRegistry implements Registry {
  readonly #options: GitHubRegistryOptions;
  readonly #plugins: { repository: string; version: string }[] = [];
  readonly #registrations: Registration[] = [];

  constructor(options: GitHubRegistryOptions = {}) {
    this.#options = options;
  }

  /** Declares decorated entity classes as block types on this registry, as `LocalRegistry.register` does. */
  register(...classes: EntityClass[]): void {
    this.#registrations.push(...classes.map(registrationOf));
  }

  /** The block types this registry declares, in order. @internal */
  get registrations(): readonly Registration[] {
    return this.#registrations;
  }

  /** Uses the plugin released by `repository` (`owner/repo`) at `version` (`vX.Y.Z`). */
  registerPlugin(repository: string, version: string): void {
    if (!repository || !version) {
      throw new SchemaError("a GitHub plugin needs a repository and a version");
    }
    this.#plugins.push({ repository, version });
  }

  /** A GitHub registry offers no functions of its own. @internal */
  get functions(): readonly RegisteredFunction[] {
    return [];
  }

  /** The registry as `CreateConfig` carries it. @internal */
  toProto(): RegistryMessage {
    return {
      kind: {
        case: "github",
        value: {
          plugins: [...this.#plugins],
          types: this.#registrations.map(declaredType),
          cacheDir: this.#options.cacheDir ?? "",
          trustedKeys: [...(this.#options.trustedKeys ?? [])],
          token: this.#options.token ?? "",
          apiUrl: this.#options.apiUrl ?? "",
        },
      },
    };
  }
}
