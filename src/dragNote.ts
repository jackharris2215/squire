import { ref } from 'vue'

// The note being dragged out of the sidebar (a Files row or a bookmark) or out of
// a pane's own header, or null. While it's set, every pane shows its drop zones:
// drop in the middle to open the note there, or on an edge to split the pane. Set
// on drag start and cleared on drag end by whoever starts the drag.
export const draggedNotePath = ref<string | null>(null)
