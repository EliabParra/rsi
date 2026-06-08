import ProxyCriminal from './ProxyCriminal.js'
import { config } from '../shared/config.js'

const DEFAULT_SEARCH_TERMS = [
  'El',
  'drug',
  'Mexican',
  'Colombian',
  'fraud',
  'murder',
  'The',
]

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function optionsFromEnv() {
  const cfg = config.loadTest ?? {}
  return {
    host: process.env.DISPATCHER_HOST || config.dispatcher.host,
    port: toInt(process.env.DISPATCHER_PORT, config.dispatcher.port),
    targetRps: toInt(process.env.TARGET_RPS, cfg.targetRps ?? 2000),
    durationSec: toInt(process.env.DURATION_SEC, cfg.durationSec ?? 30),
    virtualClients: toInt(process.env.VIRTUAL_CLIENTS, cfg.virtualClients ?? 50),
    readWriteRatio: Math.min(1, toFloat(process.env.READ_WRITE_RATIO, cfg.readWriteRatio ?? 0.9)),
    dashboardIntervalMs: toInt(process.env.DASHBOARD_INTERVAL_MS, cfg.dashboardIntervalMs ?? 500),
    tickMs: toInt(process.env.TICK_MS, 50),
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function pick(items) {
  return items[randomInt(0, items.length - 1)]
}

function makeCreatePayload(seq) {
  return {
    full_name: `Load Test Criminal ${seq}`,
    alias: `lt-${seq}`,
    nationality: pick(['Venezuelan', 'Colombian', 'Mexican', 'Brazilian', 'Peruvian']),
    crime: pick(['fraud', 'cybercrime', 'money laundering', 'extortion']),
    danger_level: randomInt(1, 5),
    captured: Math.random() > 0.5,
  }
}

function selectOperation(seq, readWriteRatio) {
  if (Math.random() < readWriteRatio) {
    const op = pick(['getById', 'list', 'search'])
    if (op === 'getById') return { name: op, args: [randomInt(1, 61)] }
    if (op === 'list') return { name: op, args: [{ limit: randomInt(5, 25), offset: randomInt(0, 20) }] }
    return { name: op, args: [pick(DEFAULT_SEARCH_TERMS)] }
  }

  const op = pick(['create', 'update'])
  if (op === 'create') return { name: op, args: [makeCreatePayload(seq)] }
  return {
    name: op,
    args: [{ id: randomInt(1, 61), captured: Math.random() > 0.5, danger_level: randomInt(1, 5) }],
  }
}

function createStats() {
  return {
    startedAt: Date.now(),
    sent: 0,
    ok: 0,
    errors: 0,
    inFlight: 0,
    latencies: [],
    completedAt: [],
    byBo: new Map(),
    byOperation: new Map(),
    byError: new Map(),
  }
}

function inc(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount)
}

function formatMap(map) {
  if (map.size === 0) return '—'
  const total = [...map.values()].reduce((sum, n) => sum + n, 0)
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${Math.round((value / total) * 100)}% (${value})`)
    .join(' | ')
}

function renderDashboard(stats, opts, final = false) {
  const elapsedSec = Math.max(0.001, (Date.now() - stats.startedAt) / 1000)
  const recentCutoff = Date.now() - 1000
  while (stats.completedAt.length > 0 && stats.completedAt[0] < recentCutoff) {
    stats.completedAt.shift()
  }

  const p50 = percentile(stats.latencies, 50)
  const p95 = percentile(stats.latencies, 95)
  const p99 = percentile(stats.latencies, 99)
  const avgRps = stats.ok / elapsedSec
  const currentRps = stats.completedAt.length

  const lines = [
    `${final ? 'FINAL' : 'LIVE'} LOAD TEST — Criminal BO via Dispatcher`,
    `target=${opts.targetRps} rps | current=${currentRps} rps | avg=${avgRps.toFixed(1)} rps | elapsed=${elapsedSec.toFixed(1)}s/${opts.durationSec}s`,
    `sent=${stats.sent} | ok=${stats.ok} | errors=${stats.errors} | inFlight=${stats.inFlight}`,
    `latency: p50=${p50}ms | p95=${p95}ms | p99=${p99}ms`,
    `distribution: ${formatMap(stats.byBo)}`,
    `operations: ${formatMap(stats.byOperation)}`,
    `errors: ${formatMap(stats.byError)}`,
    '',
    'Tip: Dispatcher prints sampled [ROUTE]/[FAILOVER] lines according to config.loadTest.sampleEvery.',
  ]

  if (process.stdout.isTTY && !final) {
    process.stdout.write('\x1b[2J\x1b[H')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function dispatchRequest(client, stats, opts, seq) {
  const operation = selectOperation(seq, opts.readWriteRatio)
  const started = nowMs()
  stats.sent += 1
  stats.inFlight += 1
  inc(stats.byOperation, operation.name)

  try {
    const response = await client[operation.name](...operation.args)
    stats.ok += 1
    stats.latencies.push(nowMs() - started)
    stats.completedAt.push(Date.now())
    inc(stats.byBo, response?._meta?.servedBy ?? 'unknown')
  } catch (err) {
    stats.errors += 1
    inc(stats.byError, err.code || err.message || 'unknown')
  } finally {
    stats.inFlight -= 1
  }
}

async function runLoadTest() {
  const opts = optionsFromEnv()
  const stats = createStats()
  const clients = Array.from({ length: opts.virtualClients }, (_, i) =>
    new ProxyCriminal(opts.host, opts.port, { clientId: `c${i}` }),
  )

  let seq = 0
  let stopped = false
  const started = Date.now()
  const durationMs = opts.durationSec * 1000
  const maxBurst = Math.max(1, Math.ceil(opts.targetRps * (opts.tickMs / 1000) * 2))

  process.on('SIGINT', () => {
    stopped = true
  })

  const dashboard = setInterval(() => renderDashboard(stats, opts), opts.dashboardIntervalMs)

  while (!stopped && Date.now() - started < durationMs) {
    const elapsedMs = Date.now() - started
    const expectedSent = Math.floor((opts.targetRps * elapsedMs) / 1000)
    const toDispatch = Math.min(maxBurst, Math.max(0, expectedSent - stats.sent))

    for (let i = 0; i < toDispatch; i++) {
      const client = clients[seq % clients.length]
      seq += 1
      dispatchRequest(client, stats, opts, seq)
    }

    await new Promise((resolve) => setTimeout(resolve, opts.tickMs))
  }

  while (stats.inFlight > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  clearInterval(dashboard)
  renderDashboard(stats, opts, true)
}

runLoadTest().catch((err) => {
  console.error('Load test failed:', err)
  process.exitCode = 1
})
