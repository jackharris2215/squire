// Lets any code ask the user to pick a note with the same search popup as Ctrl+P:
// `const path = await pickNote({ ... })` gives the chosen note's path, or null if the popup
// was dismissed. There's only ever one QuickSwitcher, so a single slot is enough; it registers
// itself once mounted (like locate.ts).
export interface PickNoteOptions {
  placeholder?: string // the search box's hint
  exclude?: string // a note's path to leave out of the list
}

let opener: ((options: PickNoteOptions) => Promise<string | null>) | null = null

export function registerNotePicker(fn: (options: PickNoteOptions) => Promise<string | null>): () => void {
  opener = fn
  return () => {
    if (opener === fn) opener = null
  }
}

export function pickNote(options: PickNoteOptions = {}): Promise<string | null> {
  return opener ? opener(options) : Promise.resolve(null)
}
