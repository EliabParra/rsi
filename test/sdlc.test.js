import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tokenize } from '../tools/sdlc/lex.js'
import { parse } from '../tools/sdlc/parse.js'
import { classifyArity, typeToString } from '../tools/sdlc/ast.js'
import { emitProxy } from '../tools/sdlc/gen-proxy.js'
import { emitRegistry } from '../tools/sdlc/gen-registry.js'
import { emitSkeleton } from '../tools/sdlc/gen-skeleton.js'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const CRIMINAL_SDL = path.join(ROOT, 'sdl', 'criminal.sdl')

function loadCriminalAst() {
  const src = fs.readFileSync(CRIMINAL_SDL, 'utf8')
  return parse(tokenize(src))
}

test('lexer: tokenizes criminal.sdl with keywords, idents, punctuation', () => {
  const src = fs.readFileSync(CRIMINAL_SDL, 'utf8')
  const tokens = tokenize(src)

  const types = tokens.map((t) => t.type)
  assert.ok(types.includes('service'), 'has service keyword')
  assert.ok(types.includes('returns'), 'has returns keyword')
  assert.ok(types.includes('lbrace') && types.includes('rbrace'))
  assert.ok(types.includes('lparen') && types.includes('rparen'))
  assert.ok(types.includes('arr'), 'has [] array marker')
  assert.ok(types.includes('opt'), 'has ? optional marker')
  assert.equal(tokens.at(-1).type, 'eof')

  // Comments and whitespace are skipped — no token should carry '//'.
  assert.ok(!tokens.some((t) => String(t.value).startsWith('//')))

  // Line numbers must advance.
  const serviceTok = tokens.find((t) => t.type === 'service')
  assert.ok(serviceTok.line >= 1)
})

test('lexer: throws on unexpected character with line info', () => {
  assert.throws(() => tokenize('service A {\n  m() @ \n}'), /line 2/)
})

test('parser: builds the Criminal service AST with 6 methods', () => {
  const ast = loadCriminalAst()
  assert.equal(ast.kind, 'File')
  assert.equal(ast.services.length, 1)

  const svc = ast.services[0]
  assert.equal(svc.name, 'Criminal')

  const names = svc.methods.map((m) => m.name)
  assert.deepEqual(names, [
    'create',
    'getById',
    'list',
    'search',
    'update',
    'remove',
  ])
})

test('parser: optional `returns` and type modifiers parse correctly', () => {
  const ast = parse(
    tokenize(`service S {
      noReturn(x: int)
      withReturn(x: int) returns Thing
      arr(x: int) returns Thing[]
      optArr(a: string?) returns Thing[]
    }`),
  )
  const [m0, m1, m2, m3] = ast.services[0].methods
  assert.equal(m0.returns, null)
  assert.equal(typeToString(m1.returns), 'Thing')
  assert.equal(typeToString(m2.returns), 'Thing[]')
  assert.equal(m3.params[0].type.optional, true)
  assert.equal(typeToString(m3.params[0].type), 'string?')
})

test('parser: throws with line number on malformed method', () => {
  assert.throws(
    () => parse(tokenize('service S {\n  bad(x int)\n}')),
    /Parse error.*line 2/,
  )
})

test('arity rule: 1 param -> positional, 0 or 2+ -> object', () => {
  const ast = loadCriminalAst()
  const byName = Object.fromEntries(
    ast.services[0].methods.map((m) => [m.name, classifyArity(m)]),
  )
  assert.equal(byName.getById, 'positional') // id
  assert.equal(byName.search, 'positional') // q
  assert.equal(byName.remove, 'positional') // id
  assert.equal(byName.create, 'object') // 6 params
  assert.equal(byName.list, 'object') // 2 params
  assert.equal(byName.update, 'object') // 7 params

  // Edge: zero params -> object.
  const zero = parse(tokenize('service S { ping() }'))
  assert.equal(classifyArity(zero.services[0].methods[0]), 'object')
})

test('gen-proxy: emits all 6 methods with correct sendBO calls', () => {
  const ast = loadCriminalAst()
  const out = emitProxy(ast)

  assert.match(out, /AUTO-GENERATED — DO NOT EDIT/)
  assert.match(out, /import ClientRSI from '\.\/ClientRSI\.js';/)
  assert.match(out, /export default class ProxyCriminal extends ClientRSI/)

  // Positional methods wrap their single param.
  assert.match(
    out,
    /async getById\(id\) \{\s*return this\.sendBO\(\{ className: 'Criminal', method: 'getById', args: \{ id \} \}\);/,
  )
  assert.match(
    out,
    /async search\(q\) \{\s*return this\.sendBO\(\{ className: 'Criminal', method: 'search', args: \{ q \} \}\);/,
  )
  assert.match(
    out,
    /async remove\(id\) \{\s*return this\.sendBO\(\{ className: 'Criminal', method: 'remove', args: \{ id \} \}\);/,
  )

  // Object methods pass args through. create/update have required params (bare args).
  assert.match(
    out,
    /async create\(args\) \{\s*return this\.sendBO\(\{ className: 'Criminal', method: 'create', args \}\);/,
  )
  assert.match(
    out,
    /async update\(args\) \{\s*return this\.sendBO\(\{ className: 'Criminal', method: 'update', args \}\);/,
  )

  // list has all-optional params -> args = {} default (matches legacy proxy).
  assert.match(
    out,
    /async list\(args = \{\}\) \{\s*return this\.sendBO\(\{ className: 'Criminal', method: 'list', args \}\);/,
  )

  // Exactly 6 async methods.
  const methodCount = (out.match(/async \w+\(/g) || []).length
  assert.equal(methodCount, 6)
})

test('gen-proxy: behaviorally equivalent to the legacy hand-written proxy', () => {
  // The legacy proxy contract: same className/method/args wiring per method.
  const ast = loadCriminalAst()
  const out = emitProxy(ast)
  const legacyContract = [
    ["create", "args"],
    ["getById", "args: { id }"],
    ["list", "args"],
    ["search", "args: { q }"],
    ["update", "args"],
    ["remove", "args: { id }"],
  ]
  for (const [method, argExpr] of legacyContract) {
    const re = new RegExp(
      `method: '${method}', ${argExpr.replace(/[{}]/g, (c) => '\\' + c)} \\}\\);`,
    )
    assert.match(out, re, `method ${method} preserves legacy arg wiring`)
  }
})

test('gen-proxy: emits JSDoc with mapped types per method', () => {
  const ast = loadCriminalAst()
  const out = emitProxy(ast)

  // Positional param typed from SDL int -> number.
  assert.match(out, /\* @param \{number\} id/)
  // Object form: required vs optional params (optional -> [bracketed]).
  assert.match(out, /\* @param \{string\} args\.full_name/)
  assert.match(out, /\* @param \{string\} \[args\.alias\]/)
  assert.match(out, /\* @param \{number\} \[args\.danger_level\]/)
  assert.match(out, /\* @param \{boolean\} \[args\.captured\]/)
  // All-optional object method gets an optional [args] bag.
  assert.match(out, /\* @param \{Object\} \[args\]/)
  // Envelope return shape, annotated with the SDL return type.
  assert.match(
    out,
    /\* @returns \{Promise<\{ msg: string, result: Object\|null \}>\} Criminal/,
  )
  // Array return type carries through.
  assert.match(
    out,
    /\* @returns \{Promise<\{ msg: string, result: Object\[\]\|null \}>\} Criminal\[\]/,
  )
})

test('gen-registry: aggregates service into routing-agnostic JSON', () => {
  const ast = loadCriminalAst()
  const json = JSON.parse(emitRegistry([{ ast, source: 'sdl/criminal.sdl' }]))

  assert.equal(json.version, 1)
  assert.deepEqual(json.generatedFrom, ['sdl/criminal.sdl'])
  assert.ok(json.services.Criminal)
  assert.equal(json.services.Criminal.className, 'Criminal')

  const m = json.services.Criminal.methods
  assert.deepEqual(m.getById.params, ['id'])
  assert.equal(m.getById.returns, 'Criminal')
  assert.deepEqual(m.list.params, ['limit', 'offset'])
  assert.equal(m.list.returns, 'Criminal[]')

  // No read/write mode anywhere — routing lives in the DB layer.
  assert.ok(!JSON.stringify(json).includes('"mode"'))
})

test('gen-skeleton: fresh emit produces class + keep markers', () => {
  const ast = loadCriminalAst()
  const out = emitSkeleton(ast)
  assert.match(out, /export class Criminal \{/)
  assert.match(out, /\/\/ <sdl:keep create>/)
  assert.match(out, /\/\/ <\/sdl:keep>/)
  // 6 keep-open markers.
  assert.equal((out.match(/<sdl:keep \w+>/g) || []).length, 6)
})

test('gen-skeleton: additive-only leaves an existing file with all methods UNTOUCHED', () => {
  const ast = loadCriminalAst()
  const existing = fs.readFileSync(
    path.join(ROOT, 'BO_Servers', 'class', 'Criminal.js'),
    'utf8',
  )
  const out = emitSkeleton(ast, existing)
  // Every SDL method already exists in the real Criminal.js -> byte-identical.
  assert.equal(out, existing)
})

test('gen-skeleton: additive-only appends only the missing method', () => {
  const ast = parse(
    tokenize('service Foo {\n  existing(x: int)\n  fresh(y: int)\n}'),
  )
  const existing = [
    'export class Foo {',
    '  async existing({ x } = {}) {',
    "    return { msg: 'real', result: x }",
    '  }',
    '}',
    '',
  ].join('\n')
  const out = emitSkeleton(ast, existing)
  // Existing body preserved verbatim.
  assert.match(out, /return \{ msg: 'real', result: x \}/)
  // New method appended.
  assert.match(out, /async fresh\(\{ y \} = \{\}\)/)
  assert.match(out, /<sdl:keep fresh>/)
  // The existing method was NOT given a fresh skeleton body.
  assert.ok(!out.includes('<sdl:keep existing>'))
})

test('idempotency: emitProxy and emitRegistry are byte-stable across runs', () => {
  const ast1 = loadCriminalAst()
  const ast2 = loadCriminalAst()

  assert.equal(emitProxy(ast1), emitProxy(ast2))
  assert.equal(
    emitRegistry([{ ast: ast1, source: 'sdl/criminal.sdl' }]),
    emitRegistry([{ ast: ast2, source: 'sdl/criminal.sdl' }]),
  )

  // Re-parsing the emitted-against source yields identical output again.
  const third = emitProxy(loadCriminalAst())
  assert.equal(third, emitProxy(ast1))
})
