import { Pool } from 'pg'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

// DbCluster — router de DB desacoplado.
//
// Construye UN pool primario (escrituras) + un ARRAY de pools de réplica
// (lecturas) a partir de la config. Enruta por la primera palabra clave del SQL:
//   - SELECT (y WITH … SELECT) → una réplica elegida round-robin, con FAILOVER
//     a la siguiente réplica y, en último caso, al primario.
//   - cualquier otra cosa (INSERT/UPDATE/DELETE/…) → primario.
//
// Cada decisión de ruteo se loguea vía el logger existente (tag DB), indicando
// qué nodo sirvió (primary vs replica #i) y cualquier failover.

// Credenciales/parámetros comunes a todos los pools (mismo user/db/max).
function baseOptions() {
  return {
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    max: config.db.max,
  }
}

// Detecta si una sentencia SQL es de solo lectura (SELECT o WITH … SELECT).
// Quita comentarios de línea (--), comentarios de bloque y espacios iniciales
// antes de mirar la palabra clave líder.
function isReadQuery(sql) {
  if (typeof sql !== 'string') return false
  const stripped = sql
    .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '')
    .trimStart()
  const keyword = stripped.slice(0, 6).toUpperCase()
  if (keyword.startsWith('SELECT')) return true
  // WITH … (CTE) cuyo statement final suele ser un SELECT → tratamos como lectura.
  if (/^WITH\b/i.test(stripped)) return true
  return false
}

export class DbCluster {
  constructor({ log = logger } = {}) {
    this.log = log
    this._rrIndex = 0

    // Pool primario (escrituras + último recurso de failover de lecturas).
    this.primary = new Pool({
      ...baseOptions(),
      host: config.db.host,
      port: config.db.port,
    })

    // Pools de réplica (lecturas). Siempre hay al menos una (degradación a 1).
    this.replicas = config.db.replicas.map((r) => new Pool({
      ...baseOptions(),
      host: r.host,
      port: r.port,
    }))

    // pg emite 'error' en un cliente IDLE del pool cuando el servidor corta esa
    // conexión (p. ej. la réplica cancela por "conflict with recovery" bajo carga).
    // Sin un listener, ese evento 'error' no manejado MATA el proceso del BO.
    // Lo logueamos: el pool descarta la conexión mala y la próxima query usa otra.
    this.primary.on('error', (err) => this.log.error('DB', `primary idle error: ${err.message}`))
    this.replicas.forEach((pool, i) => {
      pool.on('error', (err) => this.log.error('DB', `replica#${i} idle error: ${err.message}`))
    })
  }

  // Devuelve el índice de réplica para el próximo SELECT (round-robin).
  _nextReplicaIndex() {
    const index = this._rrIndex % this.replicas.length
    this._rrIndex = (this._rrIndex + 1) % this.replicas.length
    return index
  }

  // Ejecuta una escritura contra el primario.
  async write(sql, params) {
    this.log.info('DB', `WRITE → primary`)
    return this.primary.query(sql, params)
  }

  // Ejecuta una lectura contra una réplica (round-robin) con failover en cascada
  // a las réplicas restantes y, como último recurso, al primario.
  async read(sql, params) {
    const start = this._nextReplicaIndex()
    let lastError

    // Recorre todas las réplicas a partir del índice round-robin.
    for (let attempt = 0; attempt < this.replicas.length; attempt++) {
      const index = (start + attempt) % this.replicas.length
      try {
        const result = await this.replicas[index].query(sql, params)
        if (attempt === 0) {
          this.log.info('DB', `READ → replica#${index}`)
        } else {
          this.log.warn('DB', `READ → replica#${index} (failover, intento ${attempt + 1})`)
        }
        return result
      } catch (err) {
        lastError = err
        const next = (start + attempt + 1) % this.replicas.length
        const target = attempt + 1 < this.replicas.length ? `replica#${next}` : 'primary'
        this.log.warn('DB', `READ replica#${index} falló (${err.message}) → failover a ${target}`)
      }
    }

    // Último recurso: el primario también puede servir lecturas.
    try {
      const result = await this.primary.query(sql, params)
      this.log.warn('DB', `READ → primary (failover, réplicas agotadas)`)
      return result
    } catch (err) {
      this.log.error('DB', `READ falló en todas las réplicas y primario: ${err.message}`)
      throw err ?? lastError
    }
  }

  // Punto de entrada genérico: inspecciona el SQL y enruta read/write.
  async query(sql, params) {
    if (isReadQuery(sql)) {
      return this.read(sql, params)
    }
    return this.write(sql, params)
  }

  // Cierra todos los pools (útil para tests / shutdown ordenado).
  async end() {
    await Promise.all([
      this.primary.end(),
      ...this.replicas.map((pool) => pool.end()),
    ])
  }
}

// Instancia compartida del cluster — fuente única de .query para los BO.
export const db = new DbCluster()

export default db
