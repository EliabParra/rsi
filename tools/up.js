#!/usr/bin/env node
// up — one-command launcher for a machine described in topology.json.
//
// Usage:
//   node tools/up.js                         # auto-detect machine via getLocalIP()
//   node tools/up.js --machine M0            # explicit machine
//   node tools/up.js --machine M1 --dry-run  # print the plan, spawn nothing
//
// Reads topology.json, finds the target machine's `runs`, and spawns:
//   - the Dispatcher  ->  node start.js          (if runs.dispatcher)
//   - each BO id      ->  node start-bo.js --id <id> --port <port>
//
// Each child gets a per-process env derived from the topology:
//   dispatcher: DISPATCHER_HOST/PORT, RSI_HOST, DB_* (so it owns the same view)
//   BO:         BO_ID, BO_PORT, DISPATCHER_HOST, RSI_HOST, DB_*
//
// It does NOT start Postgres. If the machine runs db it prints a reminder to
// `docker compose up -d`. --dry-run prints exactly what WOULD run (with env)
// without spawning, so the plan is verifiable without a live cluster.
//
// Pure node:child_process / fs / path, ESM, zero deps.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getLocalIP } from '../shared/getLocalIP.js'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const TOPOLOGY_PATH = path.join(ROOT, 'topology.json')

const BO_SERVICE = 'Criminal'

function parseArgs() {
  const args = process.argv.slice(2)
  const result = { machine: null, dryRun: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--machine' && args[i + 1]) {
      result.machine = args[++i]
    } else if (args[i] === '--dry-run') {
      result.dryRun = true
    }
  }
  return result
}

function readTopology() {
  let raw
  try {
    raw = fs.readFileSync(TOPOLOGY_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`up: no se encontró ${TOPOLOGY_PATH}`)
      process.exit(1)
    }
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.error(`up: topology.json no es JSON válido: ${err.message}`)
    process.exit(1)
  }
}

// Auto-detect: match getLocalIP() against each machine.host in the topology.
function detectMachine(topo) {
  const ip = getLocalIP()
  for (const [name, m] of Object.entries(topo.machines)) {
    if (m.host === ip) return { name, ip }
  }
  return { name: null, ip }
}

// Shared DB env so every process on this machine owns the same view.
function dbEnv(topo, machineHost) {
  const primary = topo.db.primary
  const replicas = Array.isArray(topo.db.replicas) ? topo.db.replicas : []
  const firstReplica = replicas[0] || primary
  const env = {
    RSI_HOST: machineHost,
    DISPATCHER_HOST: topo.dispatcher.host,
    DISPATCHER_PORT: String(topo.dispatcher.port),
    DB_WRITE_HOST: primary.host,
    DB_WRITE_PORT: String(primary.port),
    DB_READ_HOST: firstReplica.host,
    DB_READ_PORT: String(firstReplica.port),
  }
  if (replicas.length > 1) {
    env.DB_READ_HOSTS = replicas.map((r) => `${r.host}:${r.port}`).join(',')
  }
  return env
}

// Build the ordered list of process descriptors for a machine.
function buildPlan(topo, machineName) {
  const machine = topo.machines[machineName]
  const runs = machine.runs || {}
  const baseEnv = dbEnv(topo, machine.host)
  const procs = []

  if (runs.dispatcher) {
    procs.push({
      label: 'dispatcher',
      cmd: 'node',
      args: ['start.js'],
      env: { ...baseEnv },
    })
  }

  // Look up each BO id this machine runs in services.Criminal to get its port.
  const instances = (topo.services && topo.services[BO_SERVICE]) || []
  const byId = new Map(instances.map((bo) => [bo.id, bo]))
  const boIds = Array.isArray(runs.bo) ? runs.bo : []
  for (const id of boIds) {
    const bo = byId.get(id)
    if (!bo) {
      console.error(`up: la máquina ${machineName} corre "${id}" pero no está en services.${BO_SERVICE}`)
      process.exit(1)
    }
    procs.push({
      label: id,
      cmd: 'node',
      args: ['start-bo.js', '--id', bo.id, '--port', String(bo.port)],
      env: { ...baseEnv, BO_ID: bo.id, BO_PORT: String(bo.port) },
    })
  }

  return { machine, runs, procs }
}

function printEnv(env) {
  for (const key of Object.keys(env)) {
    console.log(`      ${key}=${env[key]}`)
  }
}

function main() {
  const { machine: machineArg, dryRun } = parseArgs()
  const topo = readTopology()

  let machineName = machineArg
  if (!machineName) {
    const detected = detectMachine(topo)
    if (!detected.name) {
      console.error(
        `up: no pude auto-detectar la máquina. getLocalIP()=${detected.ip} ` +
          `no coincide con ningún machines[].host en topology.json.\n` +
          `    Pasá --machine <M> explícitamente (ej: --machine M0).`
      )
      process.exit(1)
    }
    machineName = detected.name
    console.log(`up: máquina auto-detectada por IP (${detected.ip}) -> ${machineName}`)
  }

  if (!topo.machines[machineName]) {
    console.error(`up: la máquina "${machineName}" no existe en topology.json.`)
    console.error(`    Disponibles: ${Object.keys(topo.machines).join(', ')}`)
    process.exit(1)
  }

  const { machine, runs, procs } = buildPlan(topo, machineName)

  console.log(`\n=== up: ${machineName} (${machine.host}) ===`)

  // Postgres no lo levantamos nosotros — solo recordamos.
  if (runs.db) {
    console.log(`\n  ⚠ Esta máquina corre la DB (${runs.db}). Levantá Postgres aparte:`)
    console.log(`      docker compose up -d`)
  }

  if (procs.length === 0) {
    console.log(`\n  Esta máquina no tiene procesos Node que levantar (solo DB, quizá).`)
    return
  }

  const verb = dryRun ? 'ARRANCARÍA' : 'arrancando'
  console.log(`\n  Plan (${procs.length} proceso(s)):`)
  for (const p of procs) {
    console.log(`\n  • [${p.label}] ${verb}: ${p.cmd} ${p.args.join(' ')}`)
    console.log(`    env:`)
    printEnv(p.env)
  }

  if (dryRun) {
    console.log(`\n  --dry-run: no se arrancó ningún proceso.`)
    return
  }

  console.log(`\n  Arrancando ${procs.length} proceso(s). Ctrl+C para detener todo.\n`)

  const children = []
  for (const p of procs) {
    const child = spawn(p.cmd, p.args, {
      cwd: ROOT,
      env: { ...process.env, ...p.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const prefix = `[${p.label}]`
    const pipe = (stream, sink) => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          sink.write(`${prefix} ${line}\n`)
        }
      })
      stream.on('end', () => {
        if (buffer.length) sink.write(`${prefix} ${buffer}\n`)
      })
    }
    pipe(child.stdout, process.stdout)
    pipe(child.stderr, process.stderr)

    child.on('exit', (code, signal) => {
      const why = signal ? `señal ${signal}` : `código ${code}`
      console.log(`${prefix} salió (${why})`)
    })

    children.push(child)
  }

  // Ctrl+C -> tumbá a todos los hijos limpiamente.
  const shutdown = () => {
    console.log('\nup: deteniendo procesos hijos...')
    for (const c of children) {
      if (!c.killed) c.kill('SIGINT')
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
