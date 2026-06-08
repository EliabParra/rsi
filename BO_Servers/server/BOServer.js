import Net from 'net'
import resolveClassInstance from '../methodResolver.js'
import { onJsonMessage, writeJson } from '../../shared/jsonStream.js'
import MetricsCollector from '../MetricsCollector.js'
import HeartbeatClient from '../HeartbeatClient.js'
import { config } from '../../shared/config.js'

/**
 * Generic N-instantiable BO server.
 *
 * Each replica is started with a unique id and port:
 *   new BOServer({ id: 'bo-1', host: '0.0.0.0', port: 4001 })
 *
 * The reflection mechanism (methodMapper → methodResolver) auto-discovers
 * every class/*.js file — no mapper changes are needed when adding or
 * removing BO classes.
 */
export default class BOServer {
  constructor({ id = 'bo-1', host = '0.0.0.0', port = 4001 } = {}) {
    this.id = id
    this.host = host
    this.port = port
    this.socketServer = null
    this.metrics = new MetricsCollector()
    this.heartbeat = null
  }

  init() {
    this.metrics.start()

    this.socketServer = Net.createServer((socket) => {
      onJsonMessage(socket, (payload) => {
        this.handleRequest(payload, socket)
      })

      socket.on('error', (err) => console.error(`[BO ${this.id}] socket error:`, err))
    })

    this.socketServer.listen(this.port, this.host, () => {
      console.log(`[BO ${this.id}] listening on ${this.host}:${this.port}`)
      this._startHeartbeat()
    })
  }

  _startHeartbeat() {
    this.heartbeat = new HeartbeatClient({
      serverId: this.id,
      // className is not fixed here — the Dispatcher maps serverId → className
      // via the register message; we advertise a generic 'BO' tag.
      // The Dispatcher in Phase 2 will map Criminal boServers by id.
      // For now, matching CalculatorServer behavior: send the primary class name.
      className: 'Criminal',
      host: this.host,
      port: this.port,
      dispatcher: config.dispatcher,
      metrics: this.metrics,
      intervalMs: config.loadBalancer?.heartbeatIntervalMs,
    })
    this.heartbeat.start()
  }

  async handleRequest(payload, socket) {
    this.metrics.requestStarted()
    try {
      const { className, method, args } = payload || {}

      if (!className || !method) {
        writeJson(socket, {
          msg: 'Invalid request: className and method are required',
          result: null,
        })
        return
      }

      const classInstance = await resolveClassInstance({ className, method })

      if (typeof classInstance === 'string') {
        writeJson(socket, { msg: classInstance, result: null })
        return
      }

      const fn = classInstance[method]
      if (typeof fn !== 'function') {
        writeJson(socket, {
          msg: `Method '${method}' not available on '${className}'`,
          result: null,
        })
        return
      }

      try {
        const result = await fn(args || {})
        // Result from CriminalService is already { msg, result }
        const response = typeof result === 'string'
          ? { msg: result, result: null }
          : result
        writeJson(socket, response)
      } catch (err) {
        writeJson(socket, {
          msg: `Error executing '${method}': ${err.message}`,
          result: null,
        })
      }
    } finally {
      this.metrics.requestFinished()
    }
  }
}
