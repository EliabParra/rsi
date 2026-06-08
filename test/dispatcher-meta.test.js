import test from 'node:test'
import assert from 'node:assert/strict'
import Net from 'net'
import Dispatcher from '../server/Dispatcher.js'
import { onJsonMessage, writeJson } from '../shared/jsonStream.js'

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

test('dispatcher wraps BO response with routing _meta', async () => {
  const bo = Net.createServer((socket) => {
    onJsonMessage(socket, () => {
      writeJson(socket, { msg: 'Criminal found', result: { id: 1 } })
      socket.end()
    })
  })
  const port = await listen(bo)

  const dispatcher = new Dispatcher()
  dispatcher.lb = {
    onDispatch() {},
    onResponse() {},
  }

  const responseSocket = {
    chunks: [],
    ended: false,
    write(chunk) { this.chunks.push(chunk) },
    end() { this.ended = true },
  }

  await new Promise((resolve, reject) => {
    responseSocket.end = function end() {
      this.ended = true
      resolve()
    }
    dispatcher.forwardWithFailover(
      [{ rank: 1, id: 'bo-1', host: '127.0.0.1', port, score: 0.91 }],
      { type: 'rpc', className: 'Criminal', method: 'getById', args: { id: 1 } },
      responseSocket,
      'Criminal',
      0,
    )
    setTimeout(() => reject(new Error('dispatcher did not respond')), 500)
  })

  bo.close()
  const payload = JSON.parse(responseSocket.chunks.join('').trim())
  assert.deepEqual(payload, {
    msg: 'Criminal found',
    result: { id: 1 },
    _meta: { servedBy: 'bo-1', rank: 1, attempts: 1 },
  })
})
