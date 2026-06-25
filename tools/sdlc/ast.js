// AST shape + helpers for the SDL compiler.
//
// AST shape:
//   File    = { kind: 'File', services: Service[] }
//   Service = { kind: 'Service', name: string, methods: Method[], line }
//   Method  = { kind: 'Method', name: string, params: Param[],
//               returns: Type | null, line }
//   Param   = { kind: 'Param', name: string, type: Type, line }
//   Type    = { kind: 'Type', name: string, array: boolean,
//               optional: boolean }

export function makeFile(services = []) {
  return { kind: 'File', services }
}

export function makeService(name, methods = [], line = 0) {
  return { kind: 'Service', name, methods, line }
}

export function makeMethod(name, params = [], returns = null, line = 0) {
  return { kind: 'Method', name, params, returns, line }
}

export function makeParam(name, type, line = 0) {
  return { kind: 'Param', name, type, line }
}

export function makeType(name, array = false, optional = false) {
  return { kind: 'Type', name, array, optional }
}

/**
 * Arity classification — the core rule that drives proxy codegen.
 *
 * Exactly 1 param  -> 'positional'  (e.g. getById(id), search(q), remove(id))
 * 0 or 2+ params   -> 'object'      (e.g. list(args={}), create(args), update(args))
 *
 * This reproduces the existing hand-written ProxyCriminal convention:
 * single-param methods take the bare value and wrap it into { name }, while
 * everything else takes a single `args` object passed straight through.
 */
export function classifyArity(method) {
  if (!method || !Array.isArray(method.params)) {
    throw new TypeError('classifyArity(method): expected a Method node')
  }
  return method.params.length === 1 ? 'positional' : 'object'
}

/** Render a Type node back to SDL surface syntax (Name[]? form). */
export function typeToString(type) {
  if (type == null) return null
  return `${type.name}${type.array ? '[]' : ''}${type.optional ? '?' : ''}`
}
