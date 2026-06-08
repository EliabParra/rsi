/**
 * start-bo.js — launch one BOServer replica.
 *
 * Usage (CLI flags):
 *   node start-bo.js --id bo-1 --port 4001
 *
 * Usage (env vars):
 *   BO_ID=bo-1 BO_PORT=4001 DB_HOST=192.168.0.10 node start-bo.js
 *
 * CLI flags take precedence over env vars.
 */

import BOServer from './BO_Servers/server/BOServer.js'

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
const host = flags.host ?? '0.0.0.0'

// DB_HOST is read by db/pool.js from process.env directly — no action needed here.
// Set DB_HOST in the environment before running if not using the default.

const bo = new BOServer({ id, host, port })
bo.init()
