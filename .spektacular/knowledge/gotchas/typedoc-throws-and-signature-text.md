---
tags: [typedoc, typescript, reference, doc-comments]
---

# TypeDoc drops `{Type}` from `@throws` and `new` from its type text

Two TypeDoc behaviours affect the API reference generated from xcl-typescript's doc comments. Both were observed on TypeDoc 0.28.20 with TypeScript 5.9.3.

**`@throws {ConfigError} when bad` loses the type.** The braces and the type disappear, and the tag's content is only `when bad`. Write `@throws {@link ConfigError} when bad`, which keeps the name as an inline link with a target.

**`Type.toString()` is not faithful.** A constructor type prints as `() => T` rather than `new () => T`, and a const with an object type prints its construct signature with no `new`. Don't build signature text from it. Take it from the compiler when the signature is created:

```js
app.converter.on(Converter.EVENT_CREATE_SIGNATURE, (context, reflection, declaration, signature) => {
  signatures.set(reflection, context.checker.signatureToString(
    signature, declaration, ts.TypeFormatFlags.NoTruncation, kind));
});
```

Also relevant when walking the model:

- A name exported as both a value and a type (`Sensitive`, `Meta`, `Entity`) becomes two reflections with the same name, so anything keyed on the name, such as a page anchor, must merge them.
- TypeDoc copies a first overload's comment onto later overloads that have none.
- `export * as events` needs its own doc comment or the namespace counts as undocumented.
- With `excludeExternals`, a class extending `Error` loses `message`, `stack` and `cause`, but keeps an inherited constructor flagged `isExternal`.
