import { Pool } from 'pg'
import { getLocalIP } from '../shared/getLocalIP.js'

// env-first fallback to hardcoded dev defaults.
// config.db is wired in Phase 2 (T2.1). Until then pool reads exclusively
// from env so the module is usable from Phase 0 onward without importing
// shared/config.js (which has no db block yet).
const localHost = process.env.RSI_HOST || getLocalIP()

const pool = new Pool({
  host:     process.env.DB_HOST     || localHost,
  port:     Number(process.env.DB_PORT) || 5432,
  user:     process.env.DB_USER     || 'rsi',
  password: process.env.DB_PASSWORD || 'rsi',
  database: process.env.DB_NAME     || 'criminals',
  max:      Number(process.env.DB_POOL_MAX) || 10,
})

export default pool
