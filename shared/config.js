import { getLocalIP } from "./getLocalIP.js"

export const config = {
    dispatcher: {
        host: getLocalIP(),
        port: 3000
    },
    boServers: {
        calculator: [
            { id: 'calc-1', host: '172.20.243.176', port: 4001 }
        ],
        equation: [
            { id: 'eq-1', host: '172.20.243.176', port: 4002 }
        ]
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
    },
    // Parámetros operativos del balanceador (Fases 2-5).
    loadBalancer: {
        // Cada cuánto cada BO server empuja su heartbeat al Dispatcher.
        heartbeatIntervalMs: 1000,
        // Si no llega heartbeat en este lapso, el server se considera unhealthy
        // y queda fuera del ranking (≈ 3 heartbeats perdidos).
        staleTimeoutMs: 3000,
        // Pesos del score. Cada grupo suma 1 para poder tunear sin tocar código.
        weights: {
            static: { cpuCores: 0.4, cpuSpeed: 0.3, totalMem: 0.3 },
            dynamic: { inFlight: 0.4, mem: 0.2, cpu: 0.2, rps: 0.2 }
        }
    }
}