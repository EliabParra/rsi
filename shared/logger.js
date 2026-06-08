const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const TAG_COLORS = {
  CLIENT: '\u001b[34m',
  DISPATCHER: '\u001b[35m',
  LB: '\u001b[33m',
  BO: '\u001b[32m',
  DB: '\u001b[36m',
  ROUTE: '\u001b[36m',
  FAILOVER: '\u001b[31m',
}

const RESET = '\u001b[0m'
const BOLD = '\u001b[1m'

function timestamp(date = new Date()) {
  return date.toISOString().slice(11, 23)
}

function formatScore(score) {
  return typeof score === 'number' && Number.isFinite(score)
    ? score.toFixed(3)
    : 'n/a'
}

function colorize(tag, text, enabled) {
  if (!enabled) return text
  const color = TAG_COLORS[tag] ?? ''
  return color ? `${color}${BOLD}${text}${RESET}` : text
}

export function createLogger({ level = 'info', color = true, sink = console.log } = {}) {
  const min = LEVELS[level] ?? LEVELS.info

  function shouldLog(nextLevel) {
    return (LEVELS[nextLevel] ?? LEVELS.info) >= min
  }

  function log(tag, message, nextLevel = 'info') {
    if (!shouldLog(nextLevel)) return
    sink(`${timestamp()} ${colorize(tag, `[${tag}]`, color)} ${message}`)
  }

  return {
    debug: (tag, message) => log(tag, message, 'debug'),
    info: (tag, message) => log(tag, message, 'info'),
    warn: (tag, message) => log(tag, message, 'warn'),
    error: (tag, message) => log(tag, message, 'error'),
    route({ reqId, clientId, targetId, rank, total, score, snapshot = {}, reason }) {
      const reqLabel = reqId ?? 'unknown'
      const clientLabel = clientId ?? 'unknown'
      const inFlight = snapshot.inFlight ?? 'n/a'
      const rps = typeof snapshot.rps === 'number' ? snapshot.rps.toFixed(1) : 'n/a'
      log(
        'ROUTE',
        `req ${reqLabel} · client ${clientLabel} → ${targetId}  (rank ${rank}/${total} · score ${formatScore(score)} · inFlight ${inFlight} · rps ${rps})  motivo: ${reason ?? 'n/a'}`,
        'info',
      )
    },
    failover({ reqId, fromId, toId, rank, error }) {
      log(
        'FAILOVER',
        `req ${reqId ?? 'unknown'} · ${fromId} no respondió (${error}) → reintenta ${toId ?? 'sin candidato'} (rank ${rank ?? 'n/a'})`,
        'warn',
      )
    },
  }
}

export const logger = createLogger()
