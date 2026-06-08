import { Pool } from 'pg'

// env-first fallback to hardcoded dev defaults.
// config.db is wired in Phase 2 (T2.1). Until then pool reads exclusively
// from env so the module is usable from Phase 0 onward without importing
// shared/config.js (which has no db block yet).
const pool = new Pool({
  host:     process.env.DB_HOST     || '192.168.0.10',
  port:     Number(process.env.DB_PORT) || 5432,
  user:     process.env.DB_USER     || 'rsi',
  password: process.env.DB_PASSWORD || 'rsi',
  database: process.env.DB_NAME     || 'criminals',
  max:      10,
})

export default pool
