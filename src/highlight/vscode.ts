/** Loading a VS Code colour theme as a theme, converted by the engine. */

import { readFile } from "node:fs/promises";

import { sharedEngineClient } from "../config.js";
import type { Theme } from "./theme.js";

/**
 * A VS Code colour theme as a theme, as Go's `highlight.LoadVSCodeTheme` loads
 * it. `source` is the theme file's path, or its contents as bytes (JSON with
 * comments, as VS Code writes it). The engine matches the theme's `tokenColors`
 * rules against each kind's TextMate scope. Only the kinds the theme styles are
 * returned, so extend the default to keep xcl's look for the rest:
 *
 * ```ts
 * const theme = { ...defaultTheme, ...(await loadVSCodeTheme("theme.json")) };
 * ```
 *
 * It needs no configuration: the engine starts on first use. A theme the engine
 * cannot use rejects with `InvalidThemeError`, whose `details.reason` says what
 * was wrong and where.
 */
export async function loadVSCodeTheme(source: string | Uint8Array): Promise<Theme> {
  const data = typeof source === "string" ? await readFile(source) : source;
  const response = await sharedEngineClient().call(0n, "convertTheme", { vscodeThemeJson: data });
  return Object.fromEntries(
    Object.entries(response.styles)
      .map(([kind, style]) => [Number(kind), style] as const)
      .sort(([left], [right]) => left - right),
  );
}
