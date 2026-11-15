#!/usr/bin/env node
/**
 * The one definition of the package's public API, and the reference built from it.
 *
 * Usage: node api-reference.mjs [--check] [--out PATH] [--source DIR]
 *
 * Reads the package through TypeDoc, from its entry point src/index.ts. A
 * public name is one the entry point exports, or one a namespace it exports
 * holds. A public member is a constructor, method or property of a public
 * class or interface, including those inherited from the package's own
 * classes, or a member of an exported value whose type is an object.
 * Protected, private and `@internal` members, and members inherited from the
 * standard library, are not public. A class's doc comment documents its
 * constructor, and enum members are listed but need no doc comment.
 *
 * `--check` prints every public name or member with no doc comment and exits
 * non-zero. Either mode also fails on a `@throws` that does not name its error
 * type with `{@link}`, since TypeDoc drops a type written as `{Type}`.
 * `--out` writes the API as the JSON the documentation site renders, in the
 * shape xcl-python's reference uses. `--source` names the directory holding
 * the package, by default the checkout holding this script.
 *
 * Signature text comes from the compiler rather than TypeDoc's type printer,
 * which loses `new`. A value and a type exported under one name become one
 * entry, with each form in `overloads`, as do the signatures of an overloaded
 * function. Doc comment Markdown is rendered to HTML here, so the site never
 * interprets it, and a `{@link}` to another entry becomes a link to its anchor.
 *
 * Used by the check-docs job of test.yml and the reference job of release.yml.
 * TypeDoc and markdown-it are development dependencies only.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import MarkdownIt from "markdown-it";
import { Application, Converter, ReflectionKind, TSConfigReader } from "typedoc";
import ts from "typescript";

export const PACKAGE = "xcl-lang";
export const SCHEMA = 1;

/** Sections of names that are not in a namespace, by the source file below src/ that defines them. */
const FILE_SECTIONS = [
  { id: "configuration", title: "Configuration", files: ["config.ts", "engine-version.ts", "internal/poll.ts"] },
  { id: "registries", title: "Registries", files: ["registry.ts"] },
  { id: "entity-types", title: "Entity types", files: ["decorators.ts", "sensitive.ts", "entity.ts"] },
  { id: "entities", title: "Entities", files: ["hydrate.ts"] },
  { id: "diffs", title: "Diffs", files: ["diff.ts"] },
  { id: "events", title: "Events and cancellation", files: ["events.ts", "interrupt.ts"] },
  { id: "printing", title: "Printing and formats", files: ["print.ts", "highlight/"] },
  { id: "masks", title: "State masks", files: ["mask.ts"] },
];
const OTHER_SECTION = { id: "other", title: "Other" };
const ERRORS_SECTION = { id: "errors", title: "Errors", files: ["errors.ts"] };

const LINK_TAGS = new Set(["@link", "@linkcode", "@linkplain"]);
const TYPE_KINDS = ReflectionKind.Class | ReflectionKind.Interface | ReflectionKind.TypeAlias | ReflectionKind.Enum;
const CALLABLE_KINDS = ReflectionKind.Function | ReflectionKind.Method | ReflectionKind.Constructor;
const FORMAT = ts.TypeFormatFlags.NoTruncation;

const markdown = new MarkdownIt({ html: false });

/** Reads the package at `source` with TypeDoc, keeping the compiler's view of each signature and symbol. */
async function load(source) {
  const app = await Application.bootstrap(
    {
      entryPoints: [join(source, "src", "index.ts")],
      tsconfig: join(source, "tsconfig.json"),
      excludeInternal: true,
      excludeProtected: true,
      excludePrivate: true,
      excludeExternals: true,
      skipErrorChecking: true,
      logLevel: "Error",
      sort: ["source-order"],
    },
    [new TSConfigReader()],
  );
  const signatures = new Map();
  const symbols = new Map();
  app.converter.on(Converter.EVENT_CREATE_SIGNATURE, (context, reflection, declaration, signature) => {
    if (signature !== undefined) {
      signatures.set(reflection, { checker: context.checker, signature, declaration });
    }
  });
  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    const symbol = context.getSymbolFromReflection(reflection);
    if (symbol !== undefined) {
      symbols.set(reflection, { checker: context.checker, symbol });
    }
  });
  const project = await app.convert();
  if (project === undefined) {
    throw new Error(`TypeDoc could not read the package at ${source}`);
  }
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  return { project, signatures, symbols, version, sourceRoot: join(resolve(source), "src") };
}

/** A type as it is written in the source, on one line: the compiler's printer drops `new` and expands aliases. */
function typeNodeText(node) {
  return node.getText().replace(/\s+/g, " ").trim();
}

/** The declaration of a symbol that a reflection was made from, when one symbol is both a value and a type. */
function declarationOf(symbol, reflection) {
  const declarations = symbol.declarations ?? [];
  const matches = {
    [ReflectionKind.Class]: ts.isClassDeclaration,
    [ReflectionKind.Interface]: ts.isInterfaceDeclaration,
    [ReflectionKind.TypeAlias]: ts.isTypeAliasDeclaration,
    [ReflectionKind.Enum]: ts.isEnumDeclaration,
    [ReflectionKind.Variable]: ts.isVariableDeclaration,
  }[reflection.kind];
  return (matches === undefined ? undefined : declarations.find((declaration) => matches(declaration))) ?? declarations[0];
}

/** Whether a TypeDoc comment holds any text. */
function hasText(comment) {
  return comment !== undefined && (comment.summary.some((part) => part.text.trim() !== "") || comment.blockTags.length > 0);
}

/** The comment that documents a reflection: its own, its first signature's, or its accessor's. */
function commentOf(reflection) {
  if (hasText(reflection.comment)) {
    return reflection.comment;
  }
  for (const signature of [...(reflection.signatures ?? []), reflection.getSignature, reflection.setSignature]) {
    if (signature !== undefined && hasText(signature.comment)) {
      return signature.comment;
    }
  }
  return undefined;
}

/** Groups reflections by name, keeping the order of each name's first appearance. */
function byName(reflections) {
  const groups = new Map();
  for (const reflection of reflections) {
    if (!groups.has(reflection.name)) {
      groups.set(reflection.name, []);
    }
    groups.get(reflection.name).push(reflection);
  }
  return [...groups.values()];
}

/** The reflection whose kind an entry takes: a type wins over a value of the same name. */
function primaryOf(reflections) {
  return reflections.find((reflection) => reflection.kindOf(TYPE_KINDS)) ?? reflections[0];
}

function kindName(reflection) {
  switch (reflection.kind) {
    case ReflectionKind.Namespace:
    case ReflectionKind.Module:
      return "namespace";
    case ReflectionKind.Class:
      return "class";
    case ReflectionKind.Interface:
      return "interface";
    case ReflectionKind.TypeAlias:
      return "type";
    case ReflectionKind.Enum:
      return "enum";
    case ReflectionKind.Function:
      return "function";
    case ReflectionKind.Method:
      return "method";
    case ReflectionKind.Constructor:
      return "constructor";
    case ReflectionKind.Property:
    case ReflectionKind.Accessor:
      return "property";
    default:
      return "constant";
  }
}

/** The object type literal of a variable or type alias, whose members and signatures belong to its entry. */
function objectTypeOf(reflection) {
  if (reflection.kindOf(ReflectionKind.Variable | ReflectionKind.TypeAlias) && reflection.type?.type === "reflection") {
    return reflection.type.declaration;
  }
  return undefined;
}

/**
 * Walks the TypeDoc model into items: one per public name or member, each
 * holding the reflections it was made from, before anything is rendered.
 */
class Walker {
  constructor(loaded) {
    this.loaded = loaded;
    this.idsByReflection = new Map();
    this.ids = new Set();
  }

  walk() {
    const sections = new Map();
    const namespaceSections = [];
    const sectionFor = (definition) => {
      if (!sections.has(definition.id)) {
        sections.set(definition.id, { id: definition.id, title: definition.title, items: [] });
      }
      return sections.get(definition.id);
    };

    const deferredReferences = [];
    for (const group of byName(this.loaded.project.children ?? [])) {
      const primary = primaryOf(group);
      const id = `${PACKAGE}.${primary.name}`;
      if (primary.kindOf(ReflectionKind.Namespace)) {
        const section = { id: `namespace-${primary.name}`, title: primary.name, items: [] };
        section.items.push(this.item(group, id));
        for (const memberGroup of byName(primary.children ?? [])) {
          section.items.push(this.item(memberGroup, `${id}.${memberGroup[0].name}`));
        }
        namespaceSections.push(section);
        continue;
      }
      const item = this.item(group, id);
      if (item.reference !== undefined) {
        deferredReferences.push(item);
        continue;
      }
      sectionFor(this.fileSection(primary)).items.push(item);
    }

    // a re-export of a namespace's member sits beside that member
    for (const item of deferredReferences) {
      const target = item.reference;
      const namespaceSection = namespaceSections.find((section) => target.parent?.name === section.title && target.parent?.kindOf(ReflectionKind.Namespace));
      if (namespaceSection !== undefined) {
        namespaceSection.items.push(item);
      } else {
        sectionFor(this.fileSection(target)).items.push(item);
      }
    }

    const ordered = [];
    for (const definition of FILE_SECTIONS) {
      if (sections.has(definition.id)) {
        ordered.push(sections.get(definition.id));
      }
    }
    ordered.push(...namespaceSections);
    for (const definition of [OTHER_SECTION, ERRORS_SECTION]) {
      if (sections.has(definition.id)) {
        ordered.push(sections.get(definition.id));
      }
    }
    return ordered.filter((section) => section.items.length > 0);
  }

  fileSection(reflection) {
    const file = reflection.sources?.[0]?.fullFileName;
    if (file === undefined) {
      return OTHER_SECTION;
    }
    const path = relative(this.loaded.sourceRoot, file).split(sep).join("/");
    for (const definition of [...FILE_SECTIONS, ERRORS_SECTION]) {
      if (definition.files.some((name) => (name.endsWith("/") ? path.startsWith(name) : path === name))) {
        return definition;
      }
    }
    return OTHER_SECTION;
  }

  register(reflection, id) {
    this.idsByReflection.set(reflection, id);
    this.ids.add(id);
  }

  /** An item for the reflections exported under one name. */
  item(group, id) {
    const primary = primaryOf(group);
    if (group.length === 1 && primary.kindOf(ReflectionKind.Reference)) {
      const target = primary.tryGetTargetReflectionDeep();
      this.register(primary, id);
      // the target may be the value of a name that is also a type, which gives the kind
      const forms = target?.parent?.children?.filter((child) => child.name === target.name) ?? [];
      const kind = target === undefined ? "constant" : kindName(primaryOf(forms.length > 0 ? forms : [target]));
      return { id, name: primary.name, kind, reflections: group, reference: target, members: [] };
    }
    for (const reflection of group) {
      this.register(reflection, id);
    }
    const item = { id, name: primary.name, kind: kindName(primary), reflections: group, members: [] };
    if (!primary.kindOf(ReflectionKind.Namespace)) {
      for (const reflection of group) {
        item.members.push(...this.members(reflection, id));
      }
    }
    return item;
  }

  /** The public members of one reflection: constructor first, then its own, then inherited ones. */
  members(reflection, parentId) {
    const children = [...(reflection.children ?? []), ...(objectTypeOf(reflection)?.children ?? [])];
    const constructors = [];
    const own = [];
    const inherited = [];
    for (const child of children) {
      if (child.flags.isExternal && !child.kindOf(ReflectionKind.Constructor)) {
        continue;
      }
      const id = `${parentId}.${child.flags.isStatic ? "static." : ""}${child.name}`;
      this.register(child, id);
      const member = { id, name: child.name, kind: kindName(child), reflections: [child], members: [], parent: reflection };
      if (child.inheritedFrom !== undefined) {
        member.inheritedFrom = child.inheritedFrom;
      }
      if (child.kindOf(ReflectionKind.Constructor)) {
        constructors.push(member);
      } else if (child.inheritedFrom !== undefined) {
        inherited.push(member);
      } else {
        own.push(member);
      }
    }
    return [...constructors, ...own, ...inherited];
  }
}

/** The ids under an item that need a doc comment and have none. */
function undocumented(item) {
  const found = [];
  if (item.reference === undefined && item.inheritedFrom === undefined) {
    const reflection = item.reflections[0];
    const exempt = reflection.kindOf(ReflectionKind.Constructor | ReflectionKind.EnumMember);
    if (!exempt) {
      if (item.reflections.length > 1) {
        for (const form of item.reflections) {
          if (commentOf(form) === undefined) {
            found.push(`${item.id} (its ${form.kindOf(TYPE_KINDS) ? "type" : "value"})`);
          }
        }
      } else if (commentOf(reflection) === undefined) {
        found.push(item.id);
      }
    }
  }
  for (const member of item.members) {
    found.push(...undocumented(member));
  }
  for (const hidden of item.hiddenMembers ?? []) {
    if (!hidden.documented) {
      found.push(hidden.id);
    }
  }
  return found;
}

/** Renders walked items to the JSON the site reads. */
class Builder {
  constructor(loaded, walker) {
    this.loaded = loaded;
    this.walker = walker;
    this.problems = [];
  }

  /** The anchor of a link target, or undefined when it is not an entry. */
  href(target) {
    if (typeof target === "string") {
      return target;
    }
    let reflection = target;
    while (reflection !== undefined && typeof reflection === "object" && "kind" in reflection) {
      const id = this.walker.idsByReflection.get(reflection);
      if (id !== undefined) {
        return `#${id}`;
      }
      if (!reflection.kindOf(ReflectionKind.CallSignature | ReflectionKind.ConstructorSignature | ReflectionKind.GetSignature | ReflectionKind.SetSignature | ReflectionKind.Parameter)) {
        return undefined;
      }
      reflection = reflection.parent;
    }
    return undefined;
  }

  /** Doc comment parts as Markdown, with each `{@link}` resolved against the entries. */
  markdownOf(parts) {
    return parts
      .map((part) => {
        if (part.kind === "inline-tag" && LINK_TAGS.has(part.tag)) {
          const label = part.tag === "@linkplain" ? part.text : `\`${part.text}\``;
          const href = this.href(part.target);
          return href === undefined ? label : `[${label}](${href})`;
        }
        return part.text;
      })
      .join("");
  }

  html(parts) {
    const text = this.markdownOf(parts).trim();
    return text === "" ? "" : markdown.render(text).trim();
  }

  /** A comment's summary with its remarks, examples and deprecation note, as HTML. */
  description(comment) {
    if (comment === undefined) {
      return "";
    }
    const blocks = [this.markdownOf(comment.summary).trim()];
    for (const tag of comment.blockTags) {
      const text = this.markdownOf(tag.content).trim();
      if (tag.tag === "@remarks") {
        blocks.push(text);
      } else if (tag.tag === "@example") {
        blocks.push(`**Example**\n\n${text}`);
      } else if (tag.tag === "@deprecated") {
        blocks.push(`**Deprecated.** ${text}`);
      }
    }
    const text = blocks.filter((block) => block !== "").join("\n\n");
    return text === "" ? "" : markdown.render(text).trim();
  }

  /** The `@throws` of a comment; each must name its error with `{@link}`. */
  raises(comment, id) {
    const raised = [];
    for (const tag of comment?.getTags("@throws") ?? []) {
      const index = tag.content.findIndex((part) => part.kind === "inline-tag" && LINK_TAGS.has(part.tag));
      if (index === -1) {
        this.problems.push(`${id}: @throws must name the error type as {@link Type}`);
        continue;
      }
      const rest = tag.content.filter((_, position) => position !== index);
      const value = { type: tag.content[index].text };
      const description = this.html(rest);
      if (description !== "") {
        value.description = description;
      }
      raised.push(value);
    }
    return raised;
  }

  entry(item) {
    const entry = { id: item.id, name: item.name, kind: item.kind };
    const primary = primaryOf(item.reflections);

    if (item.reference !== undefined) {
      const href = this.href(item.reference);
      const label = href === undefined ? item.reference.getFriendlyFullName() : href.slice(PACKAGE.length + 2);
      entry.description = this.html([{ kind: "text", text: "The same as " }, { kind: "inline-tag", tag: "@link", text: label, target: item.reference }, { kind: "text", text: "." }]);
      return entry;
    }

    if (item.reflections.length > 1) {
      // a value and a type under one name: each form is an overload
      entry.description = this.description(commentOf(primary));
      const forms = [primary, ...item.reflections.filter((form) => form !== primary)];
      entry.overloads = forms.flatMap((form) => this.forms(form, item));
    } else if (primary.kindOf(CALLABLE_KINDS)) {
      this.callable(entry, primary, item);
    } else {
      const signature = this.declarationSignature(primary, item.name);
      if (signature !== undefined) {
        entry.signature = signature;
      }
      entry.description = this.description(commentOf(primary));
      const raises = this.raises(commentOf(primary), item.id);
      if (raises.length > 0) {
        entry.raises = raises;
      }
      // a type alias's own text already shows its call or construct signature
      const callForms = primary.kindOf(ReflectionKind.TypeAlias) ? [] : [...(primary.signatures ?? []), ...(objectTypeOf(primary)?.signatures ?? [])];
      if (callForms.length > 0) {
        entry.overloads = callForms.map((signature) => this.overload(signature, item, primary.kindOf(ReflectionKind.Variable) ? item.name : ""));
      }
    }

    if (item.inheritedFrom !== undefined) {
      const definedOn = item.inheritedFrom.reflection?.parent;
      entry.inheritedFrom = (definedOn && this.walker.idsByReflection.get(definedOn)) ?? item.inheritedFrom.name.split(".")[0];
    }

    const members = item.members.map((member) => this.entry(member));
    members.push(...this.hiddenMembers(primary, item));
    if (members.length > 0) {
      entry.members = members;
    }
    return entry;
  }

  /** The forms of one reflection of a merged name. */
  forms(form, item) {
    const signatures = [...(form.signatures ?? []), ...(objectTypeOf(form)?.signatures ?? [])];
    const callableValue = form.kindOf(ReflectionKind.Variable | ReflectionKind.Function) && signatures.length > 0 && (objectTypeOf(form)?.children ?? []).length === 0;
    if (callableValue) {
      return signatures.map((signature) => this.overload(signature, item, item.name, commentOf(form)));
    }
    const overload = { signature: this.declarationSignature(form, item.name) ?? item.name };
    const description = this.description(commentOf(form));
    if (description !== "") {
      overload.description = description;
    }
    return [overload];
  }

  /** A function, method or constructor: its one signature, or an overload per signature. */
  callable(entry, reflection, item) {
    const signatures = reflection.signatures ?? [];
    const isConstructor = reflection.kindOf(ReflectionKind.Constructor);
    let comment = commentOf(reflection);
    if (isConstructor && comment === undefined) {
      entry.description = `<p>Creates a <code>${item.parent?.name ?? item.name}</code>, as the class describes.</p>`;
    } else {
      entry.description = this.description(comment);
    }
    const ofClass = item.parent?.kindOf(ReflectionKind.Class) ?? false;
    const name = isConstructor ? (ofClass ? item.parent.name : "") : item.name;
    if (signatures.length === 1) {
      const fields = this.overload(signatures[0], item, name, comment);
      delete fields.description;
      Object.assign(entry, fields);
      return;
    }
    entry.overloads = signatures.map((signature) => this.overload(signature, item, name));
    for (const overload of entry.overloads) {
      if (overload.description === entry.description) {
        delete overload.description;
      }
    }
  }

  /** One signature with its description, parameters, return value and errors. */
  overload(signature, item, name, fallbackComment) {
    const comment = hasText(signature.comment) ? signature.comment : fallbackComment;
    const result = { signature: this.signatureText(signature, name) };
    const description = this.description(comment);
    if (description !== "") {
      result.description = description;
    }
    const parameters = this.parameters(signature);
    if (parameters.length > 0) {
      result.parameters = parameters;
    }
    const returns = this.returns(signature, comment);
    if (returns !== undefined) {
      result.returns = returns;
    }
    const raises = this.raises(comment, item.id);
    if (raises.length > 0) {
      result.raises = raises;
    }
    return result;
  }

  /** A signature as the compiler prints it, after the name it is called by. */
  signatureText(signature, name) {
    const info = this.loaded.signatures.get(signature);
    const construct = signature.kindOf(ReflectionKind.ConstructorSignature);
    if (info === undefined) {
      return `${construct ? "new " : ""}${name}(…)`;
    }
    const text = info.checker.signatureToString(info.signature, info.declaration, FORMAT, construct ? ts.SignatureKind.Construct : ts.SignatureKind.Call);
    if (construct) {
      // a class's "new (options?: Options): Config" becomes "new Config(options?: Options)"; an
      // interface's construct signature keeps its own form, since the interface is not what is called
      const parameters = text.replace(/^new\s*/, "");
      if (name === "") {
        return `new ${parameters}`;
      }
      const returned = parameters.lastIndexOf(`): ${name}`);
      return `new ${name}${returned === -1 ? parameters : parameters.slice(0, returned + 1)}`;
    }
    return `${name}${text}`;
  }

  parameters(signature) {
    const info = this.loaded.signatures.get(signature);
    return (signature.parameters ?? []).map((parameter, index) => {
      const value = { name: `${parameter.flags.isRest ? "..." : ""}${parameter.name}` };
      const type = info === undefined ? parameter.type?.toString() : this.parameterType(info, index);
      if (type) {
        value.type = type;
      }
      if (parameter.defaultValue !== undefined) {
        value.default = parameter.defaultValue;
      }
      const description = this.html(parameter.comment?.summary ?? []);
      if (description !== "") {
        value.description = description;
      }
      return value;
    });
  }

  parameterType(info, index) {
    const symbol = info.signature.parameters[index];
    if (symbol === undefined) {
      return undefined;
    }
    const declaration = symbol.valueDeclaration;
    if (declaration !== undefined && ts.isParameter(declaration) && declaration.type !== undefined) {
      return typeNodeText(declaration.type);
    }
    return info.checker.typeToString(info.checker.getTypeOfSymbol(symbol), info.declaration, FORMAT);
  }

  returns(signature, comment) {
    const result = {};
    const info = this.loaded.signatures.get(signature);
    if (info !== undefined && !signature.kindOf(ReflectionKind.ConstructorSignature)) {
      const written = info.declaration !== undefined && "type" in info.declaration && info.declaration.type !== undefined ? info.declaration.type : undefined;
      const type = written === undefined ? info.checker.typeToString(info.checker.getReturnTypeOfSignature(info.signature), info.declaration, FORMAT) : typeNodeText(written);
      if (type !== "void") {
        result.type = type;
      }
    }
    const tag = comment?.getTag("@returns");
    if (tag !== undefined) {
      const description = this.html(tag.content);
      if (description !== "") {
        result.description = description;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /** The declaration line of a name that is not called: a class, interface, type, property or constant. */
  declarationSignature(reflection, name) {
    const info = this.loaded.symbols.get(reflection);
    const declaration = info === undefined ? undefined : declarationOf(info.symbol, reflection);
    if (info === undefined || declaration === undefined) {
      return undefined;
    }
    const { checker } = info;
    const typeParameters = (node) => (node.typeParameters?.length ? `<${node.typeParameters.map((parameter) => parameter.getText()).join(", ")}>` : "");
    const heritage = (node) => (node.heritageClauses ?? []).map((clause) => ` ${clause.getText()}`).join("");

    switch (reflection.kind) {
      case ReflectionKind.Class:
        return `class ${name}${typeParameters(declaration)}${heritage(declaration)}`;
      case ReflectionKind.Interface:
        return `interface ${name}${typeParameters(declaration)}${heritage(declaration)}`;
      case ReflectionKind.Enum:
        return `enum ${name}`;
      case ReflectionKind.TypeAlias: {
        if (!ts.isTypeAliasDeclaration(declaration)) {
          return `type ${name}`;
        }
        if (this.hiddenTarget(reflection) !== undefined) {
          return `type ${name}${typeParameters(declaration)}`;
        }
        return `type ${name}${typeParameters(declaration)} = ${typeNodeText(declaration.type)}`;
      }
      case ReflectionKind.EnumMember: {
        const value = ts.isEnumMember(declaration) ? checker.getConstantValue(declaration) : undefined;
        return value === undefined ? name : `${name} = ${JSON.stringify(value)}`;
      }
      case ReflectionKind.Variable: {
        const written = ts.isVariableDeclaration(declaration) ? declaration.type : undefined;
        return `const ${name}: ${written === undefined ? checker.typeToString(checker.getTypeOfSymbol(info.symbol), declaration, FORMAT) : typeNodeText(written)}`;
      }
      case ReflectionKind.Property:
      case ReflectionKind.Accessor: {
        const modifiers = `${reflection.flags.isStatic ? "static " : ""}${this.isReadonly(reflection, info.symbol) ? "readonly " : ""}`;
        const optional = reflection.flags.isOptional ? "?" : "";
        return `${modifiers}${name}${optional}: ${this.propertyType(checker, info.symbol, declaration)}`;
      }
      default:
        return undefined;
    }
  }

  isReadonly(reflection, symbol) {
    if (reflection.flags.isReadonly) {
      return true;
    }
    if (reflection.kindOf(ReflectionKind.Accessor)) {
      return reflection.setSignature === undefined;
    }
    return (symbol.declarations ?? []).some((declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0);
  }

  propertyType(checker, symbol, declaration) {
    const written = ts.isGetAccessorDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration) ? declaration.type : undefined;
    if (written !== undefined) {
      return typeNodeText(written);
    }
    return checker.typeToString(checker.getTypeOfSymbol(symbol), declaration, FORMAT);
  }

  /**
   * The interface a type alias names when the package does not export it, so
   * its members are listed on the alias: `type Entity = EntityType` would
   * otherwise show nothing a reader can use.
   */
  hiddenTarget(reflection) {
    if (!reflection.kindOf(ReflectionKind.TypeAlias) || reflection.type?.type !== "reference" || reflection.type.reflection !== undefined) {
      return undefined;
    }
    const info = this.loaded.symbols.get(reflection);
    if (info === undefined) {
      return undefined;
    }
    const type = info.checker.getDeclaredTypeOfSymbol(info.symbol);
    const properties = info.checker.getPropertiesOfType(type);
    return properties.length > 0 ? { checker: info.checker, type, properties } : undefined;
  }

  hiddenMembers(primary, item) {
    const target = item.reflections.map((reflection) => this.hiddenTarget(reflection)).find((found) => found !== undefined);
    if (target === undefined) {
      return [];
    }
    const { checker } = target;
    item.hiddenMembers = [];
    return target.properties.map((property) => {
      const id = `${item.id}.${property.name}`;
      this.walker.ids.add(id);
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const documentation = property.getDocumentationComment(checker);
      const entry = { id, name: property.name };
      const callSignatures = declaration !== undefined && ts.isMethodSignature(declaration) ? checker.getSignaturesOfType(checker.getTypeOfSymbol(property), ts.SignatureKind.Call) : [];
      if (callSignatures.length > 0) {
        entry.kind = "method";
        entry.signature = `${property.name}${checker.signatureToString(callSignatures[0], declaration, FORMAT, ts.SignatureKind.Call)}`;
        Object.assign(entry, this.compilerTags(property.getJsDocTags(checker), callSignatures[0], declaration, id));
      } else {
        entry.kind = "property";
        const readonly = declaration !== undefined && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0 ? "readonly " : "";
        const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
        entry.signature = `${readonly}${property.name}${optional}: ${declaration === undefined ? "unknown" : this.propertyType(checker, property, declaration)}`;
      }
      entry.description = this.compilerDocumentation(documentation);
      item.hiddenMembers.push({ id, documented: entry.description !== "" });
      return entry;
    });
  }

  /** A hidden method's parameters, return value and errors, from the compiler's reading of its doc comment tags. */
  compilerTags(tags, signature, declaration, id) {
    const result = {};
    const parameters = signature.parameters.map((symbol) => {
      const value = { name: symbol.name };
      const parameterDeclaration = symbol.valueDeclaration;
      if (parameterDeclaration !== undefined && ts.isParameter(parameterDeclaration) && parameterDeclaration.type !== undefined) {
        value.type = typeNodeText(parameterDeclaration.type);
      }
      const tag = tags.find((candidate) => candidate.name === "param" && candidate.text?.[0]?.text === symbol.name);
      const description = this.compilerDocumentation((tag?.text ?? []).slice(1));
      if (description !== "") {
        value.description = description;
      }
      return value;
    });
    if (parameters.length > 0) {
      result.parameters = parameters;
    }
    const returns = {};
    if (declaration.type !== undefined && declaration.type.kind !== ts.SyntaxKind.VoidKeyword) {
      returns.type = typeNodeText(declaration.type);
    }
    const returnsTag = tags.find((tag) => tag.name === "returns" || tag.name === "return");
    const returnsDescription = this.compilerDocumentation(returnsTag?.text ?? []);
    if (returnsDescription !== "") {
      returns.description = returnsDescription;
    }
    if (Object.keys(returns).length > 0) {
      result.returns = returns;
    }
    const raises = [];
    // the compiler splits `@throws {@link X}` into two tags and loses the type, so the doc comment's own text is read
    const comment = (declaration.jsDoc ?? []).map((node) => node.getText()).join("\n");
    const lines = comment.split("\n").map((line) => line.replace(/^\s*\/?\*+\/?\s?/, "").replace(/\s*\*\/\s*$/, ""));
    const blocks = lines.join("\n").split(/\n(?=@)/).filter((block) => block.startsWith("@throws"));
    for (const block of blocks) {
      const match = /^@throws\s+\{@link(?:code|plain)?\s+([^\s|}]+)[^}]*\}\s*([\s\S]*)$/.exec(block.trim());
      if (match === null) {
        this.problems.push(`${id}: @throws must name the error type as {@link Type}`);
        continue;
      }
      const value = { type: match[1] };
      const text = match[2].trim();
      const description = text === "" ? "" : markdown.render(text).trim();
      if (description !== "") {
        value.description = description;
      }
      raises.push(value);
    }
    if (raises.length > 0) {
      result.raises = raises;
    }
    return result;
  }

  /** The compiler's documentation parts as HTML, with `{@link Name}` resolved by name. */
  compilerDocumentation(parts) {
    let text = "";
    let link;
    for (const part of parts) {
      if (part.kind === "link") {
        if (link === undefined) {
          link = { name: "", label: "" };
        } else {
          const label = `\`${link.label || link.name}\``;
          const id = `${PACKAGE}.${link.name}`;
          text += this.walker.ids.has(id) ? `[${label}](#${id})` : label;
          link = undefined;
        }
      } else if (link !== undefined) {
        if (part.kind === "linkName") {
          link.name = part.text.trim();
        } else {
          link.label += part.text.trim();
        }
      } else {
        text += part.text;
      }
    }
    text = text.trim();
    return text === "" ? "" : markdown.render(text).trim();
  }
}

/**
 * Reads the package at `source`: the reference data, every problem with its
 * doc comments that fails either mode, and every public name or member with
 * no doc comment.
 */
export async function generate(source) {
  const loaded = await load(source);
  const walker = new Walker(loaded);
  const sections = walker.walk();
  const builder = new Builder(loaded, walker);
  const data = {
    schema: SCHEMA,
    language: "typescript",
    package: PACKAGE,
    version: loaded.version,
    sections: sections.map((section) => ({ id: section.id, title: section.title, entries: section.items.map((item) => builder.entry(item)) })),
  };
  const missing = sections.flatMap((section) => section.items.flatMap((item) => undocumented(item)));
  return { data, problems: builder.problems, undocumented: missing };
}

/** The checkout holding this script: .github/scripts/api-reference.mjs is two levels down. */
function defaultSource() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean", default: false },
      out: { type: "string" },
      source: { type: "string", default: defaultSource() },
    },
  });
  if (!values.check && values.out === undefined) {
    console.error("usage: api-reference.mjs [--check] [--out PATH] [--source DIR]; give --check, --out or both");
    return 2;
  }

  const { data, problems, undocumented: missing } = await generate(resolve(values.source));
  const all = [...problems];
  if (values.check) {
    all.push(...missing.map((id) => `${id}: no doc comment`));
  }
  for (const problem of all) {
    console.error(problem);
  }
  if (all.length > 0) {
    console.error(`${all.length} problem(s) in the package's doc comments`);
    return 1;
  }

  if (values.out !== undefined) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(data, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
