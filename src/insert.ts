// Lets something outside the editor (the variable menu) put text at the cursor of the
// block being edited in the focused pane. Each editor registers itself; this finds the
// one that has the focus and a block being edited.
export interface Inserter {
  isFocused: () => boolean
  canInsert: () => boolean // a block is being edited
  insert: (text: string, select?: [number, number]) => void // select: part of `text` to select afterwards
}

const inserters = new Set<Inserter>()

export function registerInserter(inserter: Inserter): () => void {
  inserters.add(inserter)
  return () => inserters.delete(inserter)
}

function target() {
  return [...inserters].find((i) => i.isFocused() && i.canInsert())
}

export const canInsertAtCursor = () => !!target()

export function insertAtCursor(text: string, select?: [number, number]) {
  target()?.insert(text, select)
}
