import { marked, type Tokens } from 'marked'

export type Align = 'left' | 'center' | 'right' | null

export interface TableData {
  header: string[]
  rows: string[][]
  align: Align[]
}

// marked can't read a literal `\|` inside a table cell, so a pipe typed into a
// cell is stored as this entity and turned back when the table is parsed.
const PIPE_ENTITY = '&#124;'

// Parses a block's markdown as a table, or returns null unless the whole block
// is exactly one table (a table with other text around it stays a text block).
export function parseTable(markdown: string): TableData | null {
  if (!markdown.includes('|')) return null
  const tokens = marked.lexer(markdown).filter((token) => token.type !== 'space')
  if (tokens.length !== 1 || tokens[0]!.type !== 'table') return null

  const table = tokens[0] as Tokens.Table
  const decode = (cell: Tokens.TableCell) => cell.text.replaceAll(PIPE_ENTITY, '|')
  return {
    header: table.header.map(decode),
    rows: table.rows.map((row) => row.map(decode)),
    align: table.align as Align[],
  }
}

export function isPureTable(markdown: string): boolean {
  return parseTable(markdown) !== null
}

export function serializeTable(table: TableData): string {
  const encode = (cell: string) => cell.replaceAll('|', PIPE_ENTITY).replace(/\n/g, ' ')
  const row = (cells: string[]) => `| ${cells.map(encode).join(' | ')} |`
  const divider = table.align.map((a) =>
    a === 'center' ? ':---:' : a === 'left' ? ':---' : a === 'right' ? '---:' : '---',
  )
  return [row(table.header), `| ${divider.join(' | ')} |`, ...table.rows.map(row)].join('\n')
}
