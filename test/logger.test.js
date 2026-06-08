import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../shared/logger.js'

test('route logger formats sampled routing decisions without color when disabled', () => {
  const lines = []
  const logger = createLogger({ level: 'info', color: false, sink: (line) => lines.push(line) })

  logger.route({ reqId: 'c7#42', clientId: 'c7', targetId: 'bo-2', rank: 1, total: 3, score: 0.8731, snapshot: { inFlight: 12, rps: 240.5 }, reason: 'mayor score del cluster' })

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2}\.\d{3} \[ROUTE\]/)
  assert.match(lines[0], /req c7#42 · client c7 → bo-2/)
  assert.match(lines[0], /rank 1\/3 · score 0\.873/)
  assert.match(lines[0], /motivo: mayor score del cluster/)
  assert.doesNotMatch(lines[0], /\u001b\[/)
})
