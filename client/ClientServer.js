/**
 * ClientServer — cliente demo del sistema RSI.
 *
 * Uso:
 *   export $(grep -v '^#' .env | xargs)
 *
 *   node client/ClientServer.js              # flujo completo Cluster DB (default)
 *   node client/ClientServer.js --full       # igual que sin argumentos
 *   node client/ClientServer.js --reads      # solo lecturas (list, search, getById)
 *   node client/ClientServer.js create       # endpoint individual
 *   node client/ClientServer.js update --id 1 --crime fraud
 *   node client/ClientServer.js remove --id 1
 *   node client/ClientServer.js getById --id 1
 *   node client/ClientServer.js list --limit 5
 *   node client/ClientServer.js search --q "El Chapo"
 */

import ProxyCriminal from './ProxyCriminal.js'
import { runClusterDbTest } from './clusterDbTest.js'
import { config } from '../shared/config.js'

const DISPATCHER_HOST = config.dispatcher.host
const DISPATCHER_PORT = config.dispatcher.port

function parseArgs(argv) {
  const args = argv.slice(2)
  const flags = {}
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--full' || a === '--reads') {
      positional.push(a.slice(2))
    } else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }

  return { cmd: positional[0] ?? 'full', flags, positional }
}

function printResult(label, res) {
  console.log(`\n--- ${label} ---`)
  console.log('msg:', res.msg)
  console.log('result:', res.result)
  if (res._meta) console.log('_meta:', res._meta)
}

async function runReadsOnly(proxy) {
  console.log('Modo: solo lecturas (→ réplica)\n')

  printResult('list(limit:5)', await proxy.list({ limit: 5 }))
  printResult('search("El Chapo")', await proxy.search('El Chapo'))
  printResult('getById(1)', await proxy.getById(1))
}

async function runEndpoint(proxy, cmd, flags) {
  switch (cmd) {
    case 'create':
      printResult('create [WRITE → primary]', await proxy.create({
        full_name: flags.name ?? `Manual-${Date.now()}`,
        alias: flags.alias,
        nationality: flags.nationality,
        crime: flags.crime ?? 'unspecified',
        danger_level: flags.danger ? Number(flags.danger) : undefined,
        captured: flags.captured === 'true',
      }))
      break

    case 'update':
      if (!flags.id) throw new Error('update requiere --id')
      printResult(`update(id=${flags.id}) [WRITE → primary]`, await proxy.update({
        id: Number(flags.id),
        full_name: flags.name,
        alias: flags.alias,
        nationality: flags.nationality,
        crime: flags.crime,
        danger_level: flags.danger ? Number(flags.danger) : undefined,
        captured: flags.captured !== undefined ? flags.captured === 'true' : undefined,
      }))
      break

    case 'remove':
      if (!flags.id) throw new Error('remove requiere --id')
      printResult(`remove(id=${flags.id}) [WRITE → primary]`, await proxy.remove(Number(flags.id)))
      break

    case 'getById':
      if (!flags.id) throw new Error('getById requiere --id')
      printResult(`getById(${flags.id}) [READ → réplica]`, await proxy.getById(Number(flags.id)))
      break

    case 'list':
      printResult('list [READ → réplica]', await proxy.list({
        limit: flags.limit ? Number(flags.limit) : 20,
        offset: flags.offset ? Number(flags.offset) : 0,
      }))
      break

    case 'search':
      if (!flags.q) throw new Error('search requiere --q')
      printResult(`search("${flags.q}") [READ → réplica]`, await proxy.search(flags.q))
      break

    case 'help':
      console.log(`
Comandos:
  (sin args) | --full     Flujo completo Cluster DB (lecturas + escrituras + sync)
  --reads                 Solo lecturas: list, search, getById(1)

  create   --name "..." --crime "..." [--alias] [--nationality] [--danger 1-5]
  update   --id N [--crime] [--name] [--alias] [--nationality] [--danger] [--captured true|false]
  remove   --id N
  getById  --id N
  list     [--limit N] [--offset N]
  search   --q "texto"
`)
      break

    default:
      throw new Error(`Comando desconocido: ${cmd}. Usá --help`)
  }
}

async function runClientApp() {
  const { cmd, flags } = parseArgs(process.argv)

  console.log('Cliente RSI')
  console.log(`Dispatcher: ${DISPATCHER_HOST}:${DISPATCHER_PORT}\n`)

  const proxy = new ProxyCriminal(DISPATCHER_HOST, DISPATCHER_PORT, {
    clientId: 'demo-client',
  })

  try {
    if (cmd === 'help') {
      await runEndpoint(proxy, 'help', flags)
      return
    }

    if (cmd === 'reads') {
      await runReadsOnly(proxy)
      return
    }

    if (cmd === 'full') {
      console.log('Modo: flujo completo Cluster DB\n')
      const summary = await runClusterDbTest(proxy)
      console.log('\n=== Flujo Cluster DB completado ===')
      console.log(`Registro: "${summary.stamp}" (id=${summary.id})`)
      return
    }

    await runEndpoint(proxy, cmd, flags)
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

runClientApp()
