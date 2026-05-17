import Net from 'net'
import os from 'os'
import { onJsonMessage, writeJson } from '../shared/jsonStream.js'
import { getLocalIP } from '../shared/getLocalIP.js'

export default class Dispatcher {
    constructor() {
        this.boServers = new Map()
    }

    loadBOServers() {
        this.boServers.set('Calculadora', {
            ip: getLocalIP(),
            port: 4000
        })
    }

    init() {
        const server = Net.createServer((socket) => {
            onJsonMessage(socket, (jsonData) => {
                jsonData.server = 'Servidor de despacho'
                writeJson(socket, jsonData)
            })

            socket.on('end', () => console.log('cliente desconectado'))
            socket.on('error', (err) => console.error(err))
        })

        server.listen(3000, () => console.log(`Servidor escuchando en ${getLocalIP()}:3000`))
    }
}