# RSI SDL — VSCode extension

Syntax highlighting and **live diagnostics** for the RSI `.sdl` service
definition language.

## What it does

- **Highlights** `.sdl` files: line comments (`//…`), the `service` and
  `returns` keywords, the service name, method names, parameter names, type
  names, the `?` (optional) and `[]` (array) modifiers, and punctuation
  (`{ } ( ) , :`).
- **Underlines syntax errors live.** As you type, the extension runs the
  project's real compiler — `tools/sdlc/lex.js` + `tools/sdlc/parse.js` — over
  the document and reports any thrown lexer/parser error on the offending line.
  No second parser, no drift: it reuses the exact compiler the build uses.

The diagnostics layer loads the ESM compiler from the CommonJS extension host
via dynamic `import()` and memoizes it. The reported line is parsed out of the
compiler's `"… at line N …"` error message (defaulting to line 0 if absent),
and diagnostics clear automatically when the document parses clean.

## How to try it

### Option A — Extension Development Host (no packaging)

1. Open this folder (`editor/vscode-sdl/`) in VSCode.
2. Press **F5**. A second VSCode window ("Extension Development Host") launches
   with the extension active.
3. Open any `.sdl` file (e.g. `../../sdl/criminal.sdl`). You should see
   highlighting immediately. Introduce a syntax error (delete a `)` or a `:`)
   and watch the error underline appear live in the Problems panel.

### Option B — Package and install

```sh
cd editor/vscode-sdl
npx vsce package
code --install-extension rsi-sdl-*.vsix
```

Then reload VSCode and open a `.sdl` file.

## Notes

- **Zero dependencies.** The extension uses only the built-in `vscode` API
  (plus Node's `path`/`url`). Nothing to `npm install` to run it.
- **Does not modify the compiler.** It imports `lex.js`/`parse.js` read-only.
- The relative path from this extension to the compiler is `../../tools/sdlc/`.
  If you move either folder, update `LEX_PATH`/`PARSE_PATH` in `extension.js`.
