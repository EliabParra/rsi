import test from 'node:test'
import assert from 'node:assert/strict'
import LoadBalancer from '../server/LoadBalancer.js'

const caps = { cpuCores: 4, cpuSpeed: 3200, totalMem: 8_000 }

function registerHealthy(lb, serverId, metrics = {}) {
  lb.register({ serverId, className: 'Criminal', host: '127.0.0.1', port: 4001, caps })
  lb.heartbeat({
    serverId,
    metrics: {
      freeMem: 6_000,
      totalMem: 8_000,
      inFlight: 0,
      rps: 10,
      cpuUtil: 0.1,
      ...metrics,
    },
  })
}

test('rank includes score, reason and routing snapshot for observability', () => {
  const lb = new LoadBalancer()
  registerHealthy(lb, 'bo-1', { inFlight: 20, rps: 200, cpuUtil: 0.7, freeMem: 2_000 })
  registerHealthy(lb, 'bo-2', { inFlight: 1, rps: 20, cpuUtil: 0.1, freeMem: 7_000 })

  const ranked = lb.rank('Criminal')

  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].id, 'bo-2')
  assert.equal(typeof ranked[0].score, 'number')
  assert.equal(ranked[0].reason, 'mayor score del cluster')
  assert.deepEqual(Object.keys(ranked[0].snapshot).sort(), [
    'capacity',
    'cpuUtil',
    'freeMemPct',
    'inFlight',
    'rps',
  ])
})
