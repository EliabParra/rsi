import { getLocalIP } from "./getLocalIP.js"

export const config = {
    dispatcher: {
        host: getLocalIP(),
        port: 3000
    },
    boServers: {
        Criminal: [
            { id: 'bo-1', host: '192.168.0.21', port: 4001 },
            { id: 'bo-2', host: '192.168.0.22', port: 4001 },
            { id: 'bo-3', host: '192.168.0.23', port: 4001 },
        ]
    },
    db: {
        host: process.env.DB_HOST || '192.168.0.10',
        port: 5432,
        user: 'rsi',
        password: 'rsi',
        database: 'criminals',
        max: 10
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
    },
    loadTest: {
        targetRps: 2000,
        durationSec: 30,
        virtualClients: 50,
        readWriteRatio: 0.9,
        sampleEvery: 200,
        dashboardIntervalMs: 500
    },
    log: {
        level: 'info',
        color: true,
        routingStream: true
    }
}
