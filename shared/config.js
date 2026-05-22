import { getLocalIP } from "./getLocalIP.js"

export const config = {
    dispatcher: {
        host: getLocalIP(),
        port: 3000
    },
    boServers: {
        calculator: {
            host: getLocalIP(),
            port: 4001
        },
        equation: {
            host: getLocalIP(),
            port: 4002
        }
    },
    clients: {
        client1: {
            host: getLocalIP(),
            port: 5001
        },
        client2: {
            host: getLocalIP(),
            port: 5002
        }
    }
}