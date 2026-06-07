import { getLocalIP } from "./getLocalIP.js"

export const config = {
    dispatcher: {
        host: getLocalIP(),
        port: 3000
    },
    boServers: {
        calculator: {
            host: '172.20.243.176',
            port: 4001
        },
        equation: {
            host: '172.20.243.176',
            port: 4002
        }
    },
    clients: {
        client1: {
            host: '172.20.243.244',
            port: 5001
        },
        client2: {
            host: '172.20.243.244',
            port: 5002
        }
    }
}