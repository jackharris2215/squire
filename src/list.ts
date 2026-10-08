import { marked, type Tokens } from 'marked'

// Parses a block's markdown as a plain list (every item a checkbox, or every item
// a plain bullet), the same way table.ts reads a table: only when the whole block
// is exactly one such list does it count, so a list with other text around it
// stays a text block.
function parseList(markdown: string): Tokens.List | null {
  if (!markdown.trim()) return null
  const tokens = marked.lexer(markdown).filter((token) => token.type !== 'space')
  if (tokens.length !== 1 || tokens[0]!.type !== 'list') return null
  const list = tokens[0] as Tokens.List
  return list.ordered ? null : list
}

export function isPureChecklist(markdown: string): boolean {
  const list = parseList(markdown)
  return !!list && list.items.every((item) => item.task)
}

export function isPureBulletList(markdown: string): boolean {
  const list = parseList(markdown)
  return !!list && list.items.every((item) => !item.task)
}
