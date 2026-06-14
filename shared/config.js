import { getLocalIP } from './getLocalIP.js'

const localHost = process.env.RSI_HOST || getLocalIP()
const toPort = (value, fallback) => {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
    dispatcher: {
        host: process.env.DISPATCHER_HOST || localHost,
        port: toPort(process.env.DISPATCHER_PORT, 3000)
    },
    boServers: {
        Criminal: [
            {
                id: process.env.BO_1_ID || 'bo-1',
                host: process.env.BO_1_HOST || localHost,
                port: toPort(process.env.BO_1_PORT, 4001)
            },
            {
                id: process.env.BO_2_ID || 'bo-2',
                host: process.env.BO_2_HOST || localHost,
                port: toPort(process.env.BO_2_PORT, 4002)
            },
            {
                id: process.env.BO_3_ID || 'bo-3',
                host: process.env.BO_3_HOST || localHost,
                port: toPort(process.env.BO_3_PORT, 4003)
            },
        ]
    },
    db: {
        host: process.env.DB_WRITE_HOST || process.env.DB_HOST || localHost,
        port: toPort(process.env.DB_WRITE_PORT || process.env.DB_PORT, 5432),
        user: process.env.DB_USER || 'rsi',
        password: process.env.DB_PASSWORD || 'rsi',
        database: process.env.DB_NAME || 'criminals',
        max: toPort(process.env.DB_POOL_MAX, 10)
    },
    // Parámetros operativos del balanceador (Fases 2-5).
    loadBalancer: {
        // Cada cuánto cada BO server empuja su heartbeat al Dispatcher.
        heartbeatIntervalMs: toPort(process.env.HEARTBEAT_INTERVAL_MS, 1000),
        // Si no llega heartbeat en este lapso, el server se considera unhealthy
        // y queda fuera del ranking (≈ 3 heartbeats perdidos).
        staleTimeoutMs: toPort(process.env.STALE_TIMEOUT_MS, 3000),
        // Pesos del score. Cada grupo suma 1 para poder tunear sin tocar código.
        weights: {
            static: { cpuCores: 0.4, cpuSpeed: 0.3, totalMem: 0.3 },
            dynamic: { inFlight: 0.4, mem: 0.2, cpu: 0.2, rps: 0.2 }
        }
    },
    loadTest: {
        targetRps: toPort(process.env.TARGET_RPS, 2000),
        durationSec: toPort(process.env.DURATION_SEC, 30),
        virtualClients: toPort(process.env.VIRTUAL_CLIENTS, 50),
        readWriteRatio: Number.parseFloat(process.env.READ_WRITE_RATIO || '0.9'),
        sampleEvery: toPort(process.env.SAMPLE_EVERY, 200),
        dashboardIntervalMs: toPort(process.env.DASHBOARD_INTERVAL_MS, 500)
    },
    log: {
        level: process.env.LOG_LEVEL || 'info',
        color: process.env.LOG_COLOR !== 'false',
        routingStream: process.env.ROUTING_STREAM !== 'false'
    }
}
