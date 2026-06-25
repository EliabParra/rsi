#!/usr/bin/env node
// topogen — generate per-machine .env files from topology.json.
//
// Usage:
//   node tools/topogen.js
//
// Reads topology.json (single source of truth for DEPLOYMENT) and writes one
// `.env.<machine>` per entry in `machines`, containing EXACTLY the env vars that
// shared/config.js consumes:
//
//   RSI_HOST            = that machine's host (so getLocalIP() never guesses wrong)
//   DISPATCHER_HOST/PORT
//   DB_WRITE_HOST/PORT  = db.primary
//   DB_READ_HOST/PORT   = db.replicas[0]
//   DB_READ_HOSTS       = "host:port,..." when there is more than one replica
//   BO_<n>_HOST/PORT/ID = positional, mirroring config.boServers.Criminal slots
//
// The BO_<n>_* mapping is POSITIONAL: services.Criminal[0] -> BO_1_*, [1] -> BO_2_*,
// [2] -> BO_3_*. That is exactly how shared/config.js indexes its three slots,
// so the order of the array — not the id string — decides the slot.
//
// Pure fs/path, ESM, zero deps. Idempotent: same topology in -> same files out.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const TOPOLOGY_PATH = path.join(ROOT, 'topology.json')

// Service whose instances map onto config.boServers.Criminal's positional slots.
const BO_SERVICE = 'Criminal'

function readTopology() {
  let raw
  try {
    raw = fs.readFileSync(TOPOLOGY_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`topogen: no se encontró ${TOPOLOGY_PATH}`)
      process.exit(1)
    }
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.error(`topogen: topology.json no es JSON válido: ${err.message}`)
    process.exit(1)
  }
}

// Build the ordered list of env lines for one machine.
function envLinesFor(machineName, topo) {
  const machine = topo.machines[machineName]
  const lines = []

  lines.push(`# Generado por tools/topogen.js desde topology.json — NO editar a mano.`)
  lines.push(`# Máquina: ${machineName} (${machine.host})`)
  lines.push('')

  // Identidad de red de esta máquina.
  lines.push(`RSI_HOST=${machine.host}`)
  lines.push('')

  // Dispatcher (todas las máquinas lo necesitan para hablarle / heartbeat).
  lines.push(`DISPATCHER_HOST=${topo.dispatcher.host}`)
  lines.push(`DISPATCHER_PORT=${topo.dispatcher.port}`)
  lines.push('')

  // DB: primary para escrituras, replica(s) para lecturas.
  const primary = topo.db.primary
  lines.push(`DB_WRITE_HOST=${primary.host}`)
  lines.push(`DB_WRITE_PORT=${primary.port}`)

  const replicas = Array.isArray(topo.db.replicas) ? topo.db.replicas : []
  const firstReplica = replicas[0] || primary
  lines.push(`DB_READ_HOST=${firstReplica.host}`)
  lines.push(`DB_READ_PORT=${firstReplica.port}`)
  if (replicas.length > 1) {
    const joined = replicas.map((r) => `${r.host}:${r.port}`).join(',')
    lines.push(`DB_READ_HOSTS=${joined}`)
  }
  lines.push('')

  // BO servers — POSICIONAL: services.Criminal[i] -> BO_<i+1>_*.
  const instances = (topo.services && topo.services[BO_SERVICE]) || []
  instances.forEach((bo, i) => {
    const n = i + 1
    lines.push(`BO_${n}_ID=${bo.id}`)
    lines.push(`BO_${n}_HOST=${bo.host}`)
    lines.push(`BO_${n}_PORT=${bo.port}`)
  })

  lines.push('')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function main() {
  const topo = readTopology()

  if (!topo.machines || typeof topo.machines !== 'object') {
    console.error('topogen: topology.json no tiene un objeto "machines".')
    process.exit(1)
  }

  const written = []
  for (const machineName of Object.keys(topo.machines)) {
    const content = envLinesFor(machineName, topo)
    const outPath = path.join(ROOT, `.env.${machineName}`)
    fs.writeFileSync(outPath, content)
    const boCount = ((topo.services && topo.services[BO_SERVICE]) || []).length
    written.push({ machineName, outPath, boCount })
  }

  console.log('topogen: archivos generados desde topology.json\n')
  for (const w of written) {
    const rel = path.relative(ROOT, w.outPath)
    console.log(`  ✓ ${rel}  (máquina ${w.machineName})`)
  }
  console.log(`\n${written.length} archivo(s) escrito(s). Idempotente: volver a correr produce lo mismo.`)
}

main()
