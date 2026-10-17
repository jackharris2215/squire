// A small Python highlighter for the script editor: turns source text into HTML with
// <span class="tok-..."> around comments, strings, numbers, keywords, builtins, decorators and
// the names after def/class. It is a tokenizer, not a parser, so odd constructs (a quote
// inside an f-string's braces, say) can be colored wrong; that is cosmetic only.

const KEYWORDS = new Set(
  ('and as assert async await break class continue def del elif else except finally for from global if import ' +
    'in is lambda nonlocal not or pass raise return try while with yield match case').split(' '),
)
const CONSTANTS = new Set(['True', 'False', 'None'])
const BUILTINS = new Set(
  ('print len range str int float bool list dict set tuple open input sorted reversed enumerate zip map filter ' +
    'sum min max abs round any all isinstance type repr format super object self cls Exception ValueError KeyError').split(' '),
)

// One alternation, tried at each position: comment, string (with its prefix, closed or
// running to the end of the line or file), number, decorator, name.
const TOKEN = new RegExp(
  [
    '(#[^\\n]*)',
    '([rRbBuUfF]{0,2}(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|"(?:\\\\.|[^"\\\\\\n])*(?:"|(?=\\n)|$)|\'(?:\\\\.|[^\'\\\\\\n])*(?:\'|(?=\\n)|$)))',
    '(\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?\\b)',
    '(@[A-Za-z_][\\w.]*)',
    '(\\b[A-Za-z_]\\w*\\b)',
  ].join('|'),
  'g',
)

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrap(kind: string, text: string): string {
  return `<span class="tok-${kind}">${escapeHtml(text)}</span>`
}

export function highlightPython(source: string): string {
  let html = ''
  let last = 0
  let previousWord = '' // the last keyword, to color the name after def and class
  for (const match of source.matchAll(TOKEN)) {
    const index = match.index!
    html += escapeHtml(source.slice(last, index))
    last = index + match[0].length
    const [text, comment, string, number, decorator, word] = match
    if (comment) html += wrap('comment', text)
    else if (string) html += wrap('string', text)
    else if (number) html += wrap('number', text)
    else if (decorator) html += wrap('decorator', text)
    else if (word) {
      if (KEYWORDS.has(word)) {
        html += wrap('keyword', text)
        previousWord = word
        continue
      }
      if (previousWord === 'def' || previousWord === 'class') html += wrap('name', text)
      else if (CONSTANTS.has(word)) html += wrap('constant', text)
      else if (BUILTINS.has(word)) html += wrap('builtin', text)
      else html += escapeHtml(text)
    }
    previousWord = ''
  }
  // The last newline of the text needs something after it, or the highlighted copy is a line
  // shorter than the text box and the two drift apart.
  return html + escapeHtml(source.slice(last)) + '\n'
}
