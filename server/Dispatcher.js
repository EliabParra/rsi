import Net from 'net'
import os from 'os'

export default class Dispatcher {
    constructor() {
        this.boServers = new Map()
    }

    #getLocalIp() {
        const interfaces = os.networkInterfaces()
        for (const interfaceName in interfaces) {
            const addresses = interfaces[interfaceName]
            for (const address of addresses) {
            if (address.family === 'IPv4' && !address.internal) return address.address
            }
        }
        return 'No se encontró IP privada'
    }


    init() {
        const server = Net.createServer((socket) => {
            socket.on('data', (buffer) => {
                const msg = buffer.toString()
                console.log('recibí:', msg)
                socket.write('respuesta: ' + msg)
            })

            socket.on('end', () => console.log('cliente desconectado'))
            socket.on('error', (err) => console.error(err))
        })

        server.listen(3000, () => console.log(`Servidor escuchando en ${this.#getLocalIp()}:3000`))
    }
}