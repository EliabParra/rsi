// Registry generator: emitRegistry(allAsts) -> string for
// sdl/services.registry.json.
//
// Aggregates one or more parsed SDL files into a single routing-agnostic
// registry. Routing (read vs write replica) is NOT in the IDL — it lives in
// the DB layer — so no mode field is emitted here.
//
// Shape:
//   {
//     version: 1,
//     generatedFrom: [<source labels>],
//     services: {
//       <ServiceName>: {
//         className: <ServiceName>,
//         methods: {
//           <methodName>: { params: [<paramNames>], returns: <type|null> }
//         }
//       }
//     }
//   }

import { typeToString } from './ast.js'

export function emitRegistry(allAsts) {
  const asts = Array.isArray(allAsts) ? allAsts : [allAsts]

  const services = {}
  const generatedFrom = []

  for (const entry of asts) {
    // Accept either a bare File AST or { ast, source } pairs.
    const ast = entry && entry.kind === 'File' ? entry : entry.ast
    const source = entry && entry.source
    if (source) generatedFrom.push(source)
    if (!ast || !Array.isArray(ast.services)) continue

    for (const service of ast.services) {
      const methods = {}
      for (const method of service.methods) {
        methods[method.name] = {
          params: method.params.map((p) => p.name),
          returns: typeToString(method.returns),
        }
      }
      services[service.name] = {
        className: service.name,
        methods,
      }
    }
  }

  const registry = {
    version: 1,
    generatedFrom: generatedFrom.sort(),
    services,
  }

  // Trailing newline keeps the file POSIX-clean and diff-stable.
  return JSON.stringify(registry, null, 2) + '\n'
}
