/** Diffs: what an apply would do. */

import { diffPath } from "./hydrate.js";

/** The value of a setting only known once the apply has run. */
export const UNKNOWN: unique symbol = Symbol("xcl.UNKNOWN");

/** How many entities an apply would create, update, replace, delete and leave unchanged. */
export interface Summary {
  /** How many entities the apply would create. */
  readonly create: number;
  /** How many entities it would update in place. */
  readonly update: number;
  /** How many entities it would destroy and create again. */
  readonly replace: number;
  /** How many entities it would destroy. */
  readonly delete: number;
  /** How many entities it would leave alone. */
  readonly unchanged: number;
}

/** One setting an apply would change. */
export interface Change {
  /** The setting's path, with attribute names in camelCase, such as `env["LOG_LEVEL"]` or `ports[0].hostPort`. */
  readonly path: string;
  /** The value before the apply. */
  readonly before: unknown;
  /** The value after the apply, or `UNKNOWN` when it is only known once it has run. */
  readonly after: unknown;
  /** Whether the value is sensitive. */
  readonly sensitive: boolean;
  /** Whether the value is only known once the apply has run. */
  readonly unknown: boolean;
}

/** A dependency whose own change affects an entity. */
export interface Dependency {
  /** The dependency's address. */
  readonly address: string;
  /** What the apply would do to it. */
  readonly action: string;
}

/** What an apply would do to one entity. */
export interface ResourceDiff {
  /** The entity's address. */
  readonly address: string;
  /** What the apply would do: `create`, `update`, `replace` or `delete`. */
  readonly action: string;
  /** Why it would be replaced, or an empty string. */
  readonly reason: string;
  /** The dependencies whose replacement forces this one. */
  readonly replacedDependencies: readonly string[];
  /** The dependencies whose own change affects it. */
  readonly dependencies: readonly Dependency[];
  /** The settings that would change. */
  readonly changes: readonly Change[];
}

/** What an apply would do: a summary and the entities it would touch. */
export class Diff {
  /** How many entities each kind of change affects. */
  readonly summary: Summary;
  /** The entities the apply would touch. */
  readonly resources: readonly ResourceDiff[];
  /** The engine's JSON for this diff, as Go writes it. */
  readonly raw: Readonly<Record<string, unknown>>;

  private constructor(summary: Summary, resources: readonly ResourceDiff[], raw: Readonly<Record<string, unknown>>) {
    this.summary = summary;
    this.resources = resources;
    this.raw = raw;
  }

  /** @internal The diff the engine sent as JSON. */
  static fromJSON(data: Uint8Array): Diff {
    const raw = (data.length > 0 ? JSON.parse(new TextDecoder().decode(data)) : {}) as JsonObject;
    const summary = (raw.summary ?? {}) as JsonObject;
    const resources = ((raw.resources ?? []) as JsonObject[]).map(resourceOf);
    return new Diff(
      {
        create: Number(summary.create ?? 0),
        update: Number(summary.update ?? 0),
        replace: Number(summary.replace ?? 0),
        delete: Number(summary.delete ?? 0),
        unchanged: Number(summary.unchanged ?? 0),
      },
      resources,
      raw,
    );
  }

  /** How many entities the apply would create, update, replace or delete. */
  changed(): number {
    return this.summary.create + this.summary.update + this.summary.replace + this.summary.delete;
  }

  /** The entry for `address`, or undefined when the apply would leave it alone. */
  resource(address: string): ResourceDiff | undefined {
    return this.resources.find((resource) => resource.address === address);
  }
}

type JsonObject = Record<string, unknown>;

function resourceOf(resource: JsonObject): ResourceDiff {
  return {
    address: String(resource.address ?? ""),
    action: String(resource.action ?? ""),
    reason: String(resource.reason ?? ""),
    replacedDependencies: (resource.replaced_dependencies ?? []) as string[],
    dependencies: ((resource.dependencies ?? []) as JsonObject[]).map((dependency) => ({
      address: String(dependency.address ?? ""),
      action: String(dependency.action ?? ""),
    })),
    changes: ((resource.changes ?? []) as JsonObject[]).map(changeOf),
  };
}

function changeOf(change: JsonObject): Change {
  const unknown = Boolean(change.unknown ?? false);
  return {
    path: diffPath(String(change.path ?? "")),
    before: change.before,
    after: unknown ? UNKNOWN : change.after,
    sensitive: Boolean(change.sensitive ?? false),
    unknown,
  };
}
