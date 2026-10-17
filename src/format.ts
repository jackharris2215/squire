// Wrapping selected text in markdown markers (Ctrl+B bold, Ctrl+I italic, ...): pure
// text in, text and selection out, so Editor.vue only has to apply the result.

// The shortcuts: Ctrl+<key> (Ctrl+Shift+X for strikethrough) and the marker each puts
// at both ends of the selection.
export const FORMATS: { key: string; shift: boolean; marker: string }[] = [
  { key: 'b', shift: false, marker: '**' }, // bold
  { key: 'i', shift: false, marker: '*' }, // italic
  { key: 'e', shift: false, marker: '`' }, // code
  { key: 'x', shift: true, marker: '~~' }, // strikethrough
]

// Italic's * is also half of bold's **, so for it a run of stars only counts as an
// italic marker when its length is odd.
function hasStart(text: string, marker: string): boolean {
  if (marker !== '*') return text.startsWith(marker)
  return (/^\*+/.exec(text)?.[0].length ?? 0) % 2 === 1
}

function hasEnd(text: string, marker: string): boolean {
  if (marker !== '*') return text.endsWith(marker)
  return (/\*+$/.exec(text)?.[0].length ?? 0) % 2 === 1
}

// Wraps the selection (start..end) in `marker`, or takes the markers off if it already
// has them (inside the selection, or just outside it). Each line is wrapped on its own,
// with spaces left outside the markers, since markdown won't bold "** text **". With
// nothing selected the markers go in as a pair with the cursor between them.
// Returns the new text and the selection to restore, still on the same words.
export function toggleWrap(text: string, start: number, end: number, marker: string) {
  const selected = text.slice(start, end)
  const size = marker.length

  if (!selected.trim()) {
    const inserted = text.slice(0, start) + marker + marker + text.slice(end)
    return { text: inserted, start: start + size, end: start + size }
  }

  // The markers sit just outside the selection: remove those.
  const before = text.slice(0, start)
  const after = text.slice(end)
  if (!selected.includes('\n') && hasEnd(before, marker) && hasStart(after, marker)) {
    const removed = before.slice(0, -size) + selected + after.slice(size)
    return { text: removed, start: start - size, end: end - size }
  }

  const lines = selected.split('\n').map((line) => {
    const [, lead = '', body = '', trail = ''] = /^(\s*)(.*?)(\s*)$/.exec(line)!
    return { lead, body, trail }
  })
  const withText = lines.filter((line) => line.body)
  const allWrapped = withText.every(
    (line) => line.body.length > 2 * size && hasStart(line.body, marker) && hasEnd(line.body, marker),
  )
  const wrapped = lines
    .map(({ lead, body, trail }) => {
      if (!body) return lead + trail
      return lead + (allWrapped ? body.slice(size, -size) : marker + body + marker) + trail
    })
    .join('\n')
  return { text: before + wrapped + after, start, end: start + wrapped.length }
}
