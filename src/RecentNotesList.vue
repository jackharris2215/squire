<script setup lang="ts">
import { computed } from 'vue'
import type { SidebarRow } from './types'
import { draggedNotePath } from './dragNote'
import { config, nameFromPath, noteList, selectedFile, selectFile } from './store'

// The sidebar's Recent Notes tab: notes visited lately, most recent first (tracked in
// store.ts's watch on selectedFile, kept in config.recentNotes so it survives a
// reload). A path whose note no longer exists (deleted, say) is just skipped, rather
// than removed from the stored list — fixing itself quietly without extra bookkeeping.
// Right-clicking a row is reported to the parent, like in the file tree.
const emit = defineEmits<{ 'row-menu': [event: MouseEvent, row: SidebarRow] }>()

const recent = computed(() =>
  (config.value.recentNotes ?? [])
    .filter((path) => noteList.value.some((n) => n.path === path))
    .map((path) => ({ path, title: nameFromPath(path) })),
)

// A recent note can be dragged into the note area like a row in the file tree.
function onDragStart(event: DragEvent, path: string) {
  draggedNotePath.value = path
  event.dataTransfer?.setData('text/plain', path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function menuRow(entry: { title: string; path: string }): SidebarRow {
  return { kind: 'note', path: entry.path, label: entry.title, depth: 0 }
}
</script>

<template>
  <div class="recent-notes scroll-area">
    <p v-if="recent.length === 0" class="recent-empty">No recently visited notes yet.</p>
    <ul v-else class="recent-list">
      <li
        v-for="entry in recent"
        :key="entry.path"
        :class="{ active: entry.path === selectedFile }"
        draggable="true"
        @dragstart="onDragStart($event, entry.path)"
        @dragend="draggedNotePath = null"
        @click="selectFile(entry.path)"
        @contextmenu.prevent.stop="emit('row-menu', $event, menuRow(entry))"
      >
        {{ entry.title }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.recent-notes {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.recent-empty {
  padding: 0.75rem;
  font-size: 0.8rem;
  color: var(--color-text);
  opacity: 0.6;
}

.recent-list {
  list-style: none;
  padding: 0.5rem;
  margin: 0;
}

.recent-list li {
  padding: 0.35rem 0.6rem;
  margin: 0.15rem 0;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
  overflow-wrap: break-word;
}

.recent-list li:hover {
  background: rgb(var(--tint) / 0.06);
}

.recent-list li.active {
  background: rgb(var(--tint) / 0.14);
}
</style>
