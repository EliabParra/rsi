import { writePool, readPool } from '../../db/pool.js'

const ALLOWED_COLUMNS = new Set([
  'full_name',
  'alias',
  'nationality',
  'crime',
  'danger_level',
  'captured',
])

export class Criminal {
  async create({ full_name, alias, nationality, crime, danger_level, captured } = {}) {
    try {
      const { rows } = await writePool.query(
        `INSERT INTO criminals (full_name, alias, nationality, crime, danger_level, captured)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          full_name,
          alias ?? null,
          nationality ?? null,
          crime,
          danger_level ?? 1,
          captured ?? false,
        ],
      )
      return { msg: 'Criminal created', result: rows[0] }
    } catch (err) {
      return { msg: `Error creating criminal: ${err.message}`, result: null }
    }
  }

  async getById({ id } = {}) {
    try {
      const { rows } = await readPool.query(
        'SELECT * FROM criminals WHERE id = $1',
        [id],
      )
      return {
        msg: rows.length ? 'Criminal found' : 'Criminal not found',
        result: rows[0] ?? null,
      }
    } catch (err) {
      return { msg: `Error fetching criminal: ${err.message}`, result: null }
    }
  }

  async list({ limit = 20, offset = 0 } = {}) {
    try {
      const { rows } = await readPool.query(
        'SELECT * FROM criminals ORDER BY id LIMIT $1 OFFSET $2',
        [limit, offset],
      )
      return { msg: `Listed ${rows.length} criminals`, result: rows }
    } catch (err) {
      return { msg: `Error listing criminals: ${err.message}`, result: null }
    }
  }

  async search({ q = '' } = {}) {
    try {
      if (!q) {
        return { msg: 'Search query (q) is required', result: null }
      }
      const pattern = `%${q}%`
      const { rows } = await readPool.query(
        `SELECT * FROM criminals
         WHERE full_name ILIKE $1 OR alias ILIKE $1
         ORDER BY id`,
        [pattern],
      )
      return { msg: `Found ${rows.length} criminals matching '${q}'`, result: rows }
    } catch (err) {
      return { msg: `Error searching criminals: ${err.message}`, result: null }
    }
  }

  async update({ id, ...fields } = {}) {
    try {
      const entries = Object.entries(fields).filter(([col]) =>
        ALLOWED_COLUMNS.has(col),
      )

      if (entries.length === 0) {
        return { msg: 'No valid fields to update', result: null }
      }

      // Build parameterized SET: col = $N (column identifiers are whitelisted above)
      const setClauses = entries.map(([col], i) => `${col} = $${i + 2}`)
      const values = [id, ...entries.map(([, v]) => v)]

      const { rows } = await writePool.query(
        `UPDATE criminals SET ${setClauses.join(', ')}
         WHERE id = $1
         RETURNING *`,
        values,
      )

      if (rows.length === 0) {
        return { msg: `Criminal ${id} not found`, result: null }
      }
      return { msg: 'Criminal updated', result: rows[0] }
    } catch (err) {
      return { msg: `Error updating criminal: ${err.message}`, result: null }
    }
  }

  async remove({ id } = {}) {
    try {
      const { rows } = await writePool.query(
        'DELETE FROM criminals WHERE id = $1 RETURNING *',
        [id],
      )

      if (rows.length === 0) {
        return { msg: `Criminal ${id} not found`, result: null }
      }
      return { msg: 'Criminal removed', result: rows[0] }
    } catch (err) {
      return { msg: `Error removing criminal: ${err.message}`, result: null }
    }
  }
}
