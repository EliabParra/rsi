// Recursive-descent parser for the SDL.
//
// Grammar (newlines terminate a method; `returns` is OPTIONAL):
//   file    = { service }
//   service = "service" Ident "{" { method } "}"
//   method  = Ident "(" [ params ] ")" [ "returns" type ]
//   params  = param { "," param }
//   param   = Ident ":" type
//   type    = Ident [ "[]" ] [ "?" ]
//
// Errors throw SyntaxError with line numbers.

import { makeFile, makeService, makeMethod, makeParam, makeType } from './ast.js'

class Cursor {
  constructor(tokens) {
    // Significant tokens drive the grammar; newlines are kept separately so
    // we can detect "newline terminates a method" without polluting the
    // structural stream.
    this.tokens = tokens
    this.i = 0
  }

  peek() {
    return this.tokens[this.i]
  }

  next() {
    return this.tokens[this.i++]
  }

  // Look at the next token, transparently skipping newlines.
  peekSignificant() {
    let j = this.i
    while (this.tokens[j] && this.tokens[j].type === 'newline') j++
    return this.tokens[j]
  }

  // Advance to and consume the next significant (non-newline) token.
  nextSignificant() {
    while (this.peek() && this.peek().type === 'newline') this.i++
    return this.next()
  }

  // True if a newline appears before the next significant token.
  newlineAhead() {
    let j = this.i
    while (this.tokens[j] && this.tokens[j].type === 'newline') {
      if (this.tokens[j].type === 'newline') return true
    }
    return false
  }
}

function fail(tok, expected) {
  const where =
    tok && tok.line != null ? ` at line ${tok.line}, col ${tok.col}` : ''
  const got = tok ? `'${tok.value || tok.type}'` : 'end of input'
  throw new SyntaxError(`Parse error: expected ${expected} but got ${got}${where}`)
}

function expect(cur, type, label) {
  const tok = cur.nextSignificant()
  if (!tok || tok.type !== type) fail(tok, label ?? type)
  return tok
}

export function parse(tokens) {
  if (!Array.isArray(tokens)) {
    throw new TypeError('parse(tokens): expected an array of tokens')
  }
  const cur = new Cursor(tokens)
  const services = []

  while (cur.peekSignificant() && cur.peekSignificant().type !== 'eof') {
    services.push(parseService(cur))
  }

  return makeFile(services)
}

function parseService(cur) {
  const kw = cur.nextSignificant()
  if (!kw || kw.type !== 'service') fail(kw, "'service' keyword")

  const name = expect(cur, 'ident', 'service name')
  expect(cur, 'lbrace', "'{'")

  const methods = []
  while (cur.peekSignificant() && cur.peekSignificant().type === 'ident') {
    methods.push(parseMethod(cur))
  }

  expect(cur, 'rbrace', "'}'")
  return makeService(name.value, methods, name.line)
}

function parseMethod(cur) {
  const name = expect(cur, 'ident', 'method name')
  expect(cur, 'lparen', "'('")

  const params = []
  if (cur.peekSignificant() && cur.peekSignificant().type !== 'rparen') {
    params.push(parseParam(cur))
    while (cur.peekSignificant() && cur.peekSignificant().type === 'comma') {
      cur.nextSignificant() // consume ','
      params.push(parseParam(cur))
    }
  }

  expect(cur, 'rparen', "')'")

  // `returns type` is OPTIONAL. Only consume it when the next significant
  // token is the `returns` keyword.
  let returns = null
  if (cur.peekSignificant() && cur.peekSignificant().type === 'returns') {
    cur.nextSignificant() // consume 'returns'
    returns = parseType(cur)
  }

  return makeMethod(name.value, params, returns, name.line)
}

function parseParam(cur) {
  const name = expect(cur, 'ident', 'parameter name')
  expect(cur, 'colon', "':'")
  const type = parseType(cur)
  return makeParam(name.value, type, name.line)
}

function parseType(cur) {
  const name = expect(cur, 'ident', 'type name')
  let array = false
  let optional = false

  if (cur.peekSignificant() && cur.peekSignificant().type === 'arr') {
    cur.nextSignificant()
    array = true
  }
  if (cur.peekSignificant() && cur.peekSignificant().type === 'opt') {
    cur.nextSignificant()
    optional = true
  }

  return makeType(name.value, array, optional)
}
