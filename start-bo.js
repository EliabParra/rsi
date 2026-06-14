/**
 * start-bo.js — launch one BOServer replica.
 *
 * Usage (CLI flags):
 *   node start-bo.js --id bo-1 --port 4001
 *
 * Usage (env vars):
 *   BO_ID=bo-1 BO_PORT=4001 DISPATCHER_HOST=127.0.0.1 node start-bo.js
 *
 * CLI flags take precedence over env vars.
 */

import BOServer from './BO_Servers/server/BOServer.js'
import { getLocalIP } from './shared/getLocalIP.js'

function parseArgs() {
  const args = process.argv.slice(2)
  const result = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) {
      result.id = args[++i]
    } else if (args[i] === '--port' && args[i + 1]) {
      result.port = parseInt(args[++i], 10)
    } else if (args[i] === '--host' && args[i + 1]) {
      result.host = args[++i]
    }
  }

  return result
}

const flags = parseArgs()

const id   = flags.id   ?? process.env.BO_ID   ?? 'bo-1'
const port = flags.port ?? parseInt(process.env.BO_PORT ?? '4001', 10)
const host = flags.host ?? getLocalIP()

if (Number.isNaN(port)) {
  console.error(`Invalid port: ${flags.port ?? process.env.BO_PORT}`)
  process.exit(1)
}

// DB hosts/ports are read by db/pool.js from process.env directly — no action needed here.
// Export .env before running: export $(grep -v '^#' .env | xargs)

const bo = new BOServer({ id, host, port })
bo.init()
