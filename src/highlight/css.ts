/** A stylesheet for the HTML format's classes, generated from a theme as Go's `highlight.WriteCSS` writes it. */

import { cssDeclarations } from "./formatters.js";
import { Kind, cssClassOf, knownKinds, parentOf } from "./kinds.js";
import { parseStyle, type Style } from "./style.js";
import type { Theme } from "./theme.js";

/**
 * A stylesheet styling the classes `html` writes as `theme` styles their kinds,
 * identical to the one Go's `highlight.WriteCSS` writes for the same theme.
 * Every rule is scoped under the `.xcl` container: a rule for `Kind.Text`'s
 * style on `.xcl` itself, then one for each kind the theme styles, categories
 * before the kinds in them. Named colours are written through the fixed palette
 * as hex, and `dim` as opacity. A kind's rule resets what its category's rule
 * sets and its own style does not, since a kind's style replaces its
 * category's whole.
 *
 * ```ts
 * writeFileSync("xcl.css", css({ ...defaultTheme, [Kind.Attribute]: "#ff8800" }));
 * ```
 */
export function css(theme: Theme): string {
  const rules: string[] = [];
  const container = cssDeclarations(parseStyle(theme[Kind.Text] ?? ""));
  if (container.length > 0) {
    rules.push(`.xcl { ${container.join("; ")}; }\n`);
  }
  for (const kind of knownKinds()) {
    const written = theme[kind] ?? "";
    if (kind === Kind.Text || written === "") {
      continue;
    }
    const parent = parentOf(kind);
    const reference = parent !== kind ? (theme[parent] ?? "") : (theme[Kind.Text] ?? "");
    const style = parseStyle(written);
    const declarations = [...cssDeclarations(style), ...cssResets(style, parseStyle(reference))];
    if (declarations.length > 0) {
      rules.push(`.xcl .${cssClassOf(kind)} { ${declarations.join("; ")}; }\n`);
    }
  }
  return rules.join("");
}

/** The declarations putting back what `inherited` sets and `style` does not. */
function cssResets(style: Style, inherited: Style): string[] {
  const resets: string[] = [];
  if (inherited.foreground !== "" && style.foreground === "") {
    resets.push("color: inherit");
  }
  if (inherited.background !== "" && style.background === "") {
    resets.push("background-color: transparent");
  }
  if (inherited.bold && !style.bold) {
    resets.push("font-weight: normal");
  }
  if (inherited.italic && !style.italic) {
    resets.push("font-style: normal");
  }
  if (inherited.underline && !style.underline) {
    resets.push("text-decoration: none");
  }
  if (inherited.dim && !style.dim) {
    resets.push("opacity: 1");
  }
  return resets;
}
