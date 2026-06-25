// RSI SDL VSCode extension.
//
// Level 2: syntax highlighting (via the TextMate grammar) + LIVE diagnostics
// that reuse the REAL compiler parser at ../../tools/sdlc/{lex,parse}.js.
//
// This file runs in VSCode's CommonJS extension host, but the compiler is ESM.
// We bridge with dynamic import(), which returns a promise we await. The parser
// is loaded ONCE (lazily, memoized) and reused for every diagnostic pass — we
// do NOT duplicate any parsing logic here.

const vscode = require('vscode')
const path = require('path')
const { pathToFileURL } = require('url')

// Absolute paths to the real compiler modules, resolved relative to this file.
// editor/vscode-sdl/extension.js  ->  tools/sdlc/{lex,parse}.js
const LEX_PATH = path.join(__dirname, '..', '..', 'tools', 'sdlc', 'lex.js')
const PARSE_PATH = path.join(__dirname, '..', '..', 'tools', 'sdlc', 'parse.js')

// Memoized parser loader. Dynamic import() of an ESM module from CommonJS
// returns a promise; we cache the resolved { tokenize, parse } pair.
let compilerPromise = null
function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = Promise.all([
      import(pathToFileURL(LEX_PATH).href),
      import(pathToFileURL(PARSE_PATH).href),
    ]).then(([lex, parse]) => ({
      tokenize: lex.tokenize,
      parse: parse.parse,
    }))
  }
  return compilerPromise
}

// Pull a 1-based line number out of a compiler error message. Both the lexer
// and parser emit messages of the form "... at line N, col C ...". VSCode
// diagnostics are 0-based, so we subtract 1. Defaults to line 0 when absent.
function lineFromError(message) {
  const m = /line\s+(\d+)/i.exec(String(message))
  if (!m) return 0
  const oneBased = parseInt(m[1], 10)
  if (!Number.isFinite(oneBased) || oneBased < 1) return 0
  return oneBased - 1
}

// Run the real compiler over a document's text and publish diagnostics.
// Clean parse -> clear diagnostics. Thrown error -> one diagnostic on the
// reported line (whole line underlined).
async function refreshDiagnostics(document, collection) {
  if (!document || document.languageId !== 'sdl') return

  let compiler
  try {
    compiler = await loadCompiler()
  } catch (err) {
    // Could not load the compiler at all — surface it once on line 0 so the
    // failure is visible rather than silent.
    const range = new vscode.Range(0, 0, 0, 1)
    const diag = new vscode.Diagnostic(
      range,
      `SDL: failed to load compiler parser: ${err && err.message ? err.message : err}`,
      vscode.DiagnosticSeverity.Error,
    )
    collection.set(document.uri, [diag])
    return
  }

  const text = document.getText()
  try {
    const tokens = compiler.tokenize(text)
    compiler.parse(tokens)
    // Parsed clean -> no problems.
    collection.set(document.uri, [])
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    const line = lineFromError(message)

    // Underline the whole reported line. Clamp to the document so the range
    // stays valid even if the source shrank since the error was produced.
    const lastLine = Math.max(0, document.lineCount - 1)
    const safeLine = Math.min(line, lastLine)
    const lineText = document.lineAt(safeLine)
    const range = new vscode.Range(
      safeLine,
      lineText.firstNonWhitespaceCharacterIndex,
      safeLine,
      lineText.range.end.character,
    )

    const diag = new vscode.Diagnostic(
      range,
      message,
      vscode.DiagnosticSeverity.Error,
    )
    diag.source = 'sdlc'
    collection.set(document.uri, [diag])
  }
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection('sdl')
  context.subscriptions.push(collection)

  // Lint already-open SDL documents on activation.
  for (const doc of vscode.workspace.textDocuments) {
    refreshDiagnostics(doc, collection)
  }

  // Lint on open.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) =>
      refreshDiagnostics(doc, collection),
    ),
  )

  // Lint live on every change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      refreshDiagnostics(event.document, collection),
    ),
  )

  // Drop diagnostics when a document is closed.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) =>
      collection.delete(doc.uri),
    ),
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
