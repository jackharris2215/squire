import { ref } from 'vue'

// Whether the Ctrl+P note switcher is open. The editor panes check it so they leave
// Ctrl mode and stop taking the arrow keys while the switcher is using them.
export const switcherOpen = ref(false)

// Whether the settings page is showing in place of the editor panes (they stay open
// underneath). Opening any note closes it (store.ts).
export const settingsOpen = ref(false)

// The sidebar row being renamed in place (its name is an input while this is set). A
// bookmark folder is identified by id, not path — it isn't a real notebook entry.
export const renaming = ref<
  { kind: 'note' | 'image' | 'pdf' | 'script' | 'folder'; path: string } | { kind: 'bookmark-folder'; id: string } | null
>(null)
