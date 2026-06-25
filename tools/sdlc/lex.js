// AUTO-GENERATED COMPILER COMPONENT — hand-written lexer for the SDL.
// Tokenizes a `.sdl` source string into a flat token stream via a single
// regex sweep. Zero dependencies.
//
// Token kinds:
//   'service' | 'returns' — keywords
//   'ident'               — identifiers (service/method/param/type names)
//   'lbrace' '}' lbrace? — punctuation: { } ( ) , : [] ?
//   'eof'                 — end of input sentinel
//
// Every token carries { type, value, line, col } so the parser can throw
// errors with precise locations.

const KEYWORDS = new Set(['service', 'returns'])

// Ordered alternation. Longest / most specific patterns first so e.g. `[]`
// wins over a lone `[`. Named groups keep the sweep readable.
const TOKEN_RE = new RegExp(
  [
    '(?<ws>[ \\t\\r]+)', // horizontal whitespace (skipped)
    '(?<nl>\\n)', // newline (tracked for line numbers; skipped as token)
    '(?<comment>//[^\\n]*)', // line comment to EOL (skipped)
    '(?<arr>\\[\\])', // array marker []
    '(?<lbrace>\\{)',
    '(?<rbrace>\\})',
    '(?<lparen>\\()',
    '(?<rparen>\\))',
    '(?<comma>,)',
    '(?<colon>:)',
    '(?<opt>\\?)', // optional marker ?
    '(?<ident>[A-Za-z_][A-Za-z0-9_]*)',
    '(?<bad>.)', // anything else -> error
  ].join('|'),
  'g',
)

const PUNCT = {
  arr: 'arr',
  lbrace: 'lbrace',
  rbrace: 'rbrace',
  lparen: 'lparen',
  rparen: 'rparen',
  comma: 'comma',
  colon: 'colon',
  opt: 'opt',
}

export function tokenize(src) {
  if (typeof src !== 'string') {
    throw new TypeError('tokenize(src): src must be a string')
  }

  const tokens = []
  let line = 1
  let lineStart = 0 // index in src where the current line begins

  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(src)) !== null) {
    const g = m.groups
    const start = m.index
    const col = start - lineStart + 1

    if (g.ws !== undefined || g.comment !== undefined) continue

    if (g.nl !== undefined) {
      tokens.push({ type: 'newline', value: '\n', line, col })
      line += 1
      lineStart = start + 1
      continue
    }

    if (g.ident !== undefined) {
      const type = KEYWORDS.has(g.ident) ? g.ident : 'ident'
      tokens.push({ type, value: g.ident, line, col })
      continue
    }

    if (g.bad !== undefined) {
      throw new SyntaxError(
        `Lex error: unexpected character '${g.bad}' at line ${line}, col ${col}`,
      )
    }

    // Remaining branches are all single-purpose punctuation.
    for (const key of Object.keys(PUNCT)) {
      if (g[key] !== undefined) {
        tokens.push({ type: key, value: g[key], line, col })
        break
      }
    }
  }

  tokens.push({ type: 'eof', value: '', line, col: src.length - lineStart + 1 })
  return tokens
}
