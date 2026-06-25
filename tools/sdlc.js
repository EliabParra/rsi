#!/usr/bin/env node
// sdlc — the SDL compiler CLI.
//
// Usage:
//   node tools/sdlc.js [globs...]     # default: sdl/*.sdl
//   node tools/sdlc.js --check [...]  # parse + diff, exit non-zero if stale
//
// Writes per run:
//   client/Proxy<Service>.js        (overwrite — pure boilerplate)
//   sdl/services.registry.json      (overwrite — aggregate of all services)
//   BO_Servers/class/<Service>.js   (create-if-absent / additive-only)
//
// Pure fs/path, ESM, zero deps.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tokenize } from './sdlc/lex.js'
import { parse } from './sdlc/parse.js'
import { emitProxy } from './sdlc/gen-proxy.js'
import { emitSkeleton } from './sdlc/gen-skeleton.js'
import { emitRegistry } from './sdlc/gen-registry.js'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')

const CLIENT_DIR = path.join(ROOT, 'client')
const BO_DIR = path.join(ROOT, 'BO_Servers', 'class')
const REGISTRY_PATH = path.join(ROOT, 'sdl', 'services.registry.json')

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Minimal glob: supports a literal directory + `*.sdl` style suffix. Anything
// without a `*` is treated as a literal path. Keeps us dependency-free.
function expandGlob(pattern) {
  if (!pattern.includes('*')) {
    return readIfExists(pattern) != null ? [pattern] : []
  }
  const dir = path.dirname(pattern)
  const base = path.basename(pattern) // e.g. *.sdl
  const re = new RegExp(
    '^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  )
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => re.test(name))
    .map((name) => path.join(dir, name))
    .sort()
}

function resolveInputs(args) {
  const globs = args.length ? args : [path.join(ROOT, 'sdl', '*.sdl')]
  const files = []
  for (const g of globs) {
    const abs = path.isAbsolute(g) ? g : path.join(process.cwd(), g)
    for (const f of expandGlob(abs)) files.push(f)
  }
  // De-dup while preserving order.
  return [...new Set(files)]
}

function compile(file) {
  const src = fs.readFileSync(file, 'utf8')
  const tokens = tokenize(src)
  const ast = parse(tokens)
  return ast
}

// Plan describes intended writes without performing them, so --check and the
// real run share one code path.
function buildPlan(files) {
  const asts = []
  const proxyWrites = [] // { path, content }
  const skeletonWrites = [] // { path, content, additive }

  for (const file of files) {
    const ast = compile(file)
    const label = path.relative(ROOT, file).split(path.sep).join('/')
    asts.push({ ast, source: label })

    for (const service of ast.services) {
      const singleAst = { kind: 'File', services: [service] }

      const proxyPath = path.join(CLIENT_DIR, `Proxy${service.name}.js`)
      proxyWrites.push({ path: proxyPath, content: emitProxy(singleAst) })

      const skelPath = path.join(BO_DIR, `${service.name}.js`)
      const existing = readIfExists(skelPath)
      skeletonWrites.push({
        path: skelPath,
        content: emitSkeleton(singleAst, existing ?? undefined),
        additive: existing != null,
      })
    }
  }

  const registryContent = emitRegistry(asts)

  return { proxyWrites, skeletonWrites, registryContent }
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function runWrite(plan) {
  const written = []

  for (const w of plan.proxyWrites) {
    fs.mkdirSync(path.dirname(w.path), { recursive: true })
    fs.writeFileSync(w.path, w.content)
    written.push(`proxy      ${rel(w.path)}`)
  }

  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true })
  fs.writeFileSync(REGISTRY_PATH, plan.registryContent)
  written.push(`registry   ${rel(REGISTRY_PATH)}`)

  for (const w of plan.skeletonWrites) {
    const existing = readIfExists(w.path)
    if (existing === w.content) {
      written.push(`skeleton   ${rel(w.path)} (unchanged)`)
      continue
    }
    fs.mkdirSync(path.dirname(w.path), { recursive: true })
    fs.writeFileSync(w.path, w.content)
    written.push(
      `skeleton   ${rel(w.path)} (${w.additive ? 'updated/additive' : 'created'})`,
    )
  }

  return written
}

// --check: compare what WOULD be written against what's on disk for the
// overwrite artifacts (proxy + registry). Skeletons are additive/create-only,
// so a missing skeleton is not a staleness failure; but if an existing
// skeleton would change (a new SDL method needs appending), that IS reported.
function runCheck(plan) {
  const stale = []

  for (const w of plan.proxyWrites) {
    const onDisk = readIfExists(w.path)
    if (onDisk !== w.content) stale.push(rel(w.path))
  }

  const regOnDisk = readIfExists(REGISTRY_PATH)
  if (regOnDisk !== plan.registryContent) stale.push(rel(REGISTRY_PATH))

  for (const w of plan.skeletonWrites) {
    const onDisk = readIfExists(w.path)
    // Only flag existing skeletons that would gain appended methods.
    if (onDisk != null && onDisk !== w.content) stale.push(rel(w.path))
  }

  return stale
}

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const globs = argv.filter((a) => a !== '--check')

  const files = resolveInputs(globs)
  if (files.length === 0) {
    console.error('sdlc: no .sdl files matched', globs.length ? globs : '(default sdl/*.sdl)')
    process.exit(1)
  }

  let plan
  try {
    plan = buildPlan(files)
  } catch (err) {
    console.error(`sdlc: ${err.message}`)
    process.exit(1)
  }

  if (check) {
    const stale = runCheck(plan)
    if (stale.length > 0) {
      console.error('sdlc --check: generated output is STALE. Re-run `pnpm gen`:')
      for (const s of stale) console.error(`  - ${s}`)
      process.exit(1)
    }
    console.log('sdlc --check: generated output is up to date.')
    return
  }

  const written = runWrite(plan)
  console.log(`sdlc: compiled ${files.length} file(s):`)
  for (const f of files) console.log(`  source     ${rel(f)}`)
  console.log('sdlc: wrote:')
  for (const w of written) console.log(`  ${w}`)
}

main()
