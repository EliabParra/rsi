import Net from 'net'
import { onJsonMessage, writeJson } from '../shared/jsonStream.js'
import { config } from '../shared/config.js'
import LoadBalancer from './LoadBalancer.js'
import { createLogger } from '../shared/logger.js'

export default class Dispatcher {
    constructor() {
        this.boServers = new Map()
        this.lb = new LoadBalancer(config.loadBalancer)
        this.logger = createLogger(config.log)
        this.reqSeq = 0
    }

    loadBOServers() {
        this.boServers.set('Criminal', config.boServers.Criminal)
    }

    init() {
        this.loadBOServers()

        this.socketServer = Net.createServer((socket) => {
            onJsonMessage(socket, (payload) => {
                this.handleRequest(payload, socket)
            })
            socket.on("error", (err) => console.error("Dispatcher error:", err))
        })

        // Pruning periódico de servers con heartbeat vencido.
        const prune = setInterval(() => this.lb.prune(), config.loadBalancer?.staleTimeoutMs ?? 3000)
        prune.unref?.()

        this.socketServer.listen(config.dispatcher.port, config.dispatcher.host, () => console.log(`Servidor escuchando en ${config.dispatcher.host}:${config.dispatcher.port}`))
    }

    // Ramifica por tipo de mensaje (Fase 4):
    // - register / heartbeat → alimentan el LB (conexión persistente, NO se cierra).
    // - rpc (o sin type, por compatibilidad) → ranking + forward al BO server elegido.
    handleRequest(payload, socket) {
        const type = payload?.type ?? 'rpc'

        if (type === 'register') {
            this.lb.register(payload)
            return
        }
        if (type === 'heartbeat') {
            this.lb.heartbeat(payload)
            return
        }

        this.handleRpc(payload, socket)
    }

    handleRpc(payload, socket) {
        const { method, className, args, clientId } = payload
        this.reqSeq += 1
        const reqId = payload?.reqId ?? `req-${this.reqSeq}`
        const ranked = this.resolveTargets(className)

        if (ranked.length === 0) {
            writeJson(socket, { message: `No se encontró el servidor de objetos de negocio para la clase ${className}` })
            socket.end()
            return
        }

        const forwardPayload = { type: 'rpc', method, className, args }
        this.forwardWithFailover(ranked, forwardPayload, socket, className, 0, { reqId, clientId })
    }

    // Lista de instancias destino ordenada por preferencia.
    // El LB decide en función de las métricas en tiempo real; si todavía no hay
    // heartbeats (arranque) cae al listado estático de config.
    resolveTargets(className) {
        const ranked = this.lb.rank(className)
        if (ranked.length > 0) return ranked

        const instances = this.boServers.get(className) || []
        return instances.map((inst, i) => ({
            rank: i + 1,
            id: inst.id,
            host: inst.host,
            port: inst.port,
            score: null,
            reason: 'fallback estático (sin heartbeats)',
            snapshot: {},
        }))
    }

    // Intenta el rank 1; si la conexión falla, cae en cascada al rank 2, 3…
    forwardWithFailover(ranked, forwardPayload, socket, className, index, context = {}) {
        if (index >= ranked.length) {
            writeJson(socket, { message: `Error al conectar con el servidor de objetos de negocio ${className}` })
            socket.end()
            return
        }

        const target = ranked[index]
        this.lb.onDispatch(target.id)
        let done = false

        const forwardSocket = Net.createConnection({ port: target.port, host: target.host }, () => {
            writeJson(forwardSocket, forwardPayload)
        })

        onJsonMessage(forwardSocket, (response) => {
            if (done) return
            done = true
            this.lb.onResponse(target.id)
            const responseWithMeta = {
                ...response,
                _meta: { servedBy: target.id, rank: target.rank, attempts: index + 1 },
            }
            this.logRouteDecision(context, target, ranked.length)
            writeJson(socket, responseWithMeta)
            forwardSocket.end()
            socket.end()
        })

        forwardSocket.on('error', (err) => {
            if (done) return
            done = true
            this.lb.onResponse(target.id)
            const next = ranked[index + 1]
            this.logger.failover({ reqId: context.reqId, fromId: target.id, toId: next?.id, rank: next?.rank, error: err.message })
            forwardSocket.destroy()
            // Cascada al siguiente candidato.
            this.forwardWithFailover(ranked, forwardPayload, socket, className, index + 1, context)
        })
    }

    logRouteDecision(context, target, total) {
        if (!config.log?.routingStream) return
        const sampleEvery = config.loadTest?.sampleEvery ?? 1
        const seq = this.reqSeq || 1
        const shouldSample = sampleEvery <= 1 || seq % sampleEvery === 0
        if (!shouldSample) return

        this.logger.route({
            reqId: context.reqId,
            clientId: context.clientId,
            targetId: target.id,
            rank: target.rank,
            total,
            score: target.score,
            snapshot: target.snapshot,
            reason: target.reason,
        })
    }

}
