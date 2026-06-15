import { Pool } from 'pg'
import { getLocalIP } from '../shared/getLocalIP.js'

const localHost = process.env.RSI_HOST || getLocalIP()

const base = {
  user: process.env.DB_USER || 'rsi',
  password: process.env.DB_PASSWORD || 'rsi',
  database: process.env.DB_NAME || 'criminals',
  max: Number(process.env.DB_POOL_MAX) || 10,
}

export const writePool = new Pool({
  ...base,
  host: process.env.DB_WRITE_HOST || process.env.DB_HOST || localHost,
  port: Number(process.env.DB_WRITE_PORT || process.env.DB_PORT || 5432),
})

export const readPool = new Pool({
  ...base,
  host: process.env.DB_READ_HOST || process.env.DB_HOST || localHost,
  port: Number(process.env.DB_READ_PORT || process.env.DB_PORT || 5432),
})

// pg emite 'error' en un cliente IDLE del pool cuando el servidor corta esa
// conexión (p. ej. la réplica cancela por "conflict with recovery" bajo carga).
// Sin un listener, ese evento 'error' no manejado MATA el proceso del BO.
// Lo logueamos: el pool descarta la conexión mala y la próxima query usa otra.
writePool.on('error', (err) => console.error('[db] writePool error:', err.message))
readPool.on('error', (err) => console.error('[db] readPool error:', err.message))

export default writePool
