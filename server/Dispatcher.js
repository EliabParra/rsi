import Net from 'net'
import { onJsonMessage, writeJson } from '../shared/jsonStream.js'
import { config } from '../shared/config.js'

export default class Dispatcher {
    constructor() {
        this.boServers = new Map()
    }

    loadBOServers() {
        this.boServers.set('Calculator', config.boServers.calculator)
        this.boServers.set('Equations', config.boServers.equation)
    }

    init() {
        this.loadBOServers()

        this.socketServer = Net.createServer((socket) => {
            onJsonMessage(socket, (payload) => {
                this.handleRequest(payload, socket)
            })
            socket.on("error", (err) => console.error("Dispatcher error:", err))
        })

        this.socketServer.listen(config.dispatcher.port, config.dispatcher.host, () => console.log(`Servidor escuchando en ${config.dispatcher.host}:${config.dispatcher.port}`))
    }

    handleRequest(payload, socket) {
        const { method, className, args } = payload
        const instances = this.boServers.get(className)

        if (!instances || instances.length === 0) {
            writeJson(socket, { message: `No se encontró el servidor de objetos de negocio para la clase ${className}` })
            socket.end()
            return
        }

        const boServer = this.selectBOServer(instances)
        const forwardPayload = { method, className, args }
        this.forwardToBOServer(boServer, forwardPayload, socket, className)
    }

    // Selección de la instancia destino.
    // Fase 0: sin LoadBalancer todavía, se toma la primera instancia disponible.
    // En la Fase 4 esto se reemplaza por la decisión rankeada del LoadBalancer.
    selectBOServer(instances) {
        return instances[0]
    }

    forwardToBOServer(boServer, forwardPayload, socket, className) {
        const forwardSocket = Net.createConnection({ port: boServer.port, host: boServer.host }, () => {
            writeJson(forwardSocket, forwardPayload)
        })

        onJsonMessage(forwardSocket, (response) => {
            writeJson(socket, response)
            forwardSocket.end()
            socket.end()
        })

        forwardSocket.on('error', (err) => {
            console.error(`Error al conectar con el servidor de objetos de negocio ${className}:`, err)
            writeJson(socket, { message: `Error al conectar con el servidor de objetos de negocio ${className}` })
            socket.end()
        })
    }
}
