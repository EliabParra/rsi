/**
 * Smoke test del flujo Cluster DB vía Dispatcher → BO → DbCluster (write→primary / read→réplica).
 *
 * Uso directo:
 *   export $(grep -v '^#' .env | xargs) && node client/clusterDbTest.js
 */

import ProxyCriminal from './ProxyCriminal.js'
import { config } from '../shared/config.js'
import { fileURLToPath } from 'url'

const DISPATCHER_HOST = config.dispatcher.host
const DISPATCHER_PORT = config.dispatcher.port

function log(tag, msg, data = null) {
  const line = `[${tag}] ${msg}`
  if (data !== null) console.log(line, data)
  else console.log(line)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Ejecuta el flujo completo de lecturas y escrituras contra el cluster DB.
 * @param {ProxyCriminal} proxy
 * @param {{ stamp?: string, replicationWaitMs?: number }} [opts]
 */
export async function runClusterDbTest(proxy, opts = {}) {
  const stamp = opts.stamp ?? `ClientTest-${Date.now()}`
  const waitMs = opts.replicationWaitMs ?? 500
  const results = []

  const step = (name, tag, fn) => async () => {
    log(tag, `▶ ${name}`)
    const res = await fn()
    results.push({ name, tag, ok: true, res })
    log(tag, `✓ ${name}`, res.msg ?? res)
    return res
  }

  // --- Lecturas (readPool → réplica) ---
  await step('list({ limit: 5 })', 'READ → réplica', () =>
    proxy.list({ limit: 5 }),
  )()
  const listRes = results.at(-1).res
  assert(listRes.result?.length > 0, 'list vacío: la réplica no tiene datos del seed')

  await step('search("El Chapo")', 'READ → réplica', () =>
    proxy.search('El Chapo'),
  )()

  await step('getById(1)', 'READ → réplica', () => proxy.getById(1))()

  // --- Escrituras (writePool → primary) ---
  const createRes = await step('create', 'WRITE → primary', () =>
    proxy.create({ full_name: stamp, crime: 'smoke-test', danger_level: 2 }),
  )()
  assert(createRes.result?.id, `create falló: ${createRes.msg}`)
  const id = createRes.result.id
  if (createRes._meta?.servedBy) {
    log('ROUTING', `create atendido por ${createRes._meta.servedBy}`)
  }

  // --- Verificar replicación (readPool → réplica) ---
  log('SYNC', `esperando ${waitMs}ms por replication lag…`)
  await sleep(waitMs)

  let got = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await proxy.getById(id)
    if (res.result) {
      got = res.result
      log('READ → réplica', `✓ getById(${id}) — réplica sincronizada (intento ${attempt})`)
      break
    }
    await sleep(200)
  }
  assert(got?.full_name === stamp, `réplica no recibió el create (id=${id})`)
  results.push({ name: `getById(${id})`, tag: 'READ → réplica', ok: true, res: { msg: 'Réplica sincronizada', result: got } })

  const updateRes = await step(`update(id=${id})`, 'WRITE → primary', () =>
    proxy.update({ id, crime: 'updated-crime' }),
  )()
  assert(updateRes.result?.crime === 'updated-crime', `update falló: ${updateRes.msg}`)

  await sleep(waitMs)
  const searchRes = await step(`search("${stamp}")`, 'READ → réplica', () =>
    proxy.search(stamp),
  )()
  assert(
    searchRes.result?.some((r) => r.crime === 'updated-crime'),
    'search en réplica no ve el update',
  )

  const removeRes = await step(`remove(id=${id})`, 'WRITE → primary', () =>
    proxy.remove(id),
  )()
  assert(removeRes.result?.id === id, `remove falló: ${removeRes.msg}`)

  await sleep(waitMs)
  const goneRes = await proxy.getById(id)
  assert(goneRes.result === null, 'réplica aún muestra el registro eliminado')
  log('READ → réplica', `✓ getById(${id}) — registro eliminado en réplica`)
  results.push({ name: `getById(${id}) post-remove`, tag: 'READ → réplica', ok: true, res: goneRes })

  return { stamp, id, results, passed: true }
}

async function main() {
  console.log('=== Cluster DB Smoke Test (Cliente → Dispatcher → BO) ===\n')
  console.log(`Dispatcher: ${DISPATCHER_HOST}:${DISPATCHER_PORT}\n`)

  const proxy = new ProxyCriminal(DISPATCHER_HOST, DISPATCHER_PORT, {
    clientId: 'cluster-db-test',
  })

  try {
    const summary = await runClusterDbTest(proxy)
    console.log('\n=== Todos los pasos pasaron ===')
    console.log(`Registro de prueba: "${summary.stamp}" (id=${summary.id})`)
    console.log(`Pasos ejecutados: ${summary.results.length}`)
    process.exit(0)
  } catch (err) {
    console.error('\n=== FALLO ===')
    console.error(err.message)
    process.exit(1)
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
