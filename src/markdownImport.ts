import { marked } from 'marked'
import type { Block } from './types'
import { randomUUID } from './uuid'

// Splits an imported markdown file into blocks. marked's lexer already breaks
// markdown into exactly the units we want each in their own block — a heading, a
// table, a list, a code block, or a paragraph (blank lines already separate one
// paragraph from the next) — so there's no need to hand-write that splitting:
// each non-blank top-level token becomes one block, keeping its own markdown text.
export function blocksFromMarkdown(text: string): Block[][] {
  const tokens = marked.lexer(text).filter((token) => token.type !== 'space')
  return tokens
    .map((token) => token.raw.trim())
    .filter((content) => content.length > 0)
    .map((content) => [{ id: `block-${randomUUID()}`, type: 'text', content }])
}
