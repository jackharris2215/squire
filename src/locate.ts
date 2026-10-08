// Lets a note's "Locate in browser" button scroll its row into view in the sidebar
// tree. There's only ever one FileTree, so a single slot (not a registry like
// blockActions.ts's) is enough; it registers itself once mounted.
let reveal: ((path: string) => void) | null = null

export function registerTreeReveal(fn: (path: string) => void): () => void {
  reveal = fn
  return () => {
    if (reveal === fn) reveal = null
  }
}

export function revealInTree(path: string) {
  reveal?.(path)
}
