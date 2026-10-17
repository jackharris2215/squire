import { closeDrawer } from './mobile'

// Lets the block browser (right panel) act on the blocks of the note in the focused pane:
// show one, or float one where it is. Each editor registers itself; this finds the one
// that has the focus, the same way insert.ts does for the variable menu.
export interface BlockActions {
  isFocused: () => boolean
  reveal: (blockId: string) => void // select it, scroll it into view, bring a floating one to the front
  unhook: (blockIds: string[]) => void
}

const actions = new Set<BlockActions>()

export function registerBlockActions(entry: BlockActions): () => void {
  actions.add(entry)
  return () => actions.delete(entry)
}

function target() {
  return [...actions].find((a) => a.isFocused())
}

export const revealBlock = (blockId: string) => {
  closeDrawer() // on a phone the panel is covering the block
  target()?.reveal(blockId)
}
export const unhookBlocksInFocused = (blockIds: string[]) => target()?.unhook(blockIds)
