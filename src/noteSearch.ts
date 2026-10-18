import { baseName, imageList, noteList, pdfList, scriptList } from './store'

// Finds notes, images, PDFs and scripts by name for the Ctrl+P switcher and the [[
// autocomplete — everything the file tree shows, so a new file kind there belongs here too.
// A note's name is its title; anything else's is its full filename, extension included.
// Every word typed must appear somewhere in the name (any case). Names that start
// with what was typed come first, then the rest alphabetically.
export function findNotes(query: string) {
  const typed = query.trim().toLowerCase()
  const words = typed.split(/\s+/).filter(Boolean)
  const rank = (title: string) => (title.toLowerCase().startsWith(typed) ? 0 : 1)
  const entries = [
    ...noteList.value.map((n) => ({ title: n.title, path: n.path })),
    ...[...imageList.value, ...pdfList.value, ...scriptList.value].map((path) => ({ title: baseName(path), path })),
  ]
  return entries
    .filter((n) => words.every((word) => n.title.toLowerCase().includes(word)))
    .sort((a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title))
}

// The folder part of a notebook-relative path ('' for a note in the top level).
export function folderOf(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}
