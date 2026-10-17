<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { isImagePath, isPdfPath, selectFile } from './store'
import { findNotes, folderOf } from './noteSearch'
import { switcherOpen } from './overlay'
import FileIcon from './FileIcon.vue'

// Ctrl+P: a search box for jumping to a note by name. The parent opens it
// (defineExpose below) from the keyboard shortcut.
const isOpen = ref(false)
const query = ref('')
const selected = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

async function open() {
  query.value = ''
  selected.value = 0
  isOpen.value = true
  await nextTick()
  input.value?.focus()
}

function close() {
  isOpen.value = false
}

function toggle() {
  if (isOpen.value) close()
  else open()
}

defineExpose({ toggle })

const results = computed(() => findNotes(query.value))

watch(query, () => {
  selected.value = 0
})

watch(isOpen, (open) => {
  switcherOpen.value = open
})

function openNote(path: string) {
  close()
  selectFile(path)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close()
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    selected.value = Math.min(selected.value + 1, results.value.length - 1)
    scrollToSelected()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    selected.value = Math.max(selected.value - 1, 0)
    scrollToSelected()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const choice = results.value[selected.value]
    if (choice) openNote(choice.path)
  }
}

async function scrollToSelected() {
  await nextTick()
  list.value?.children[selected.value]?.scrollIntoView({ block: 'nearest' })
}
</script>

<template>
  <div v-if="isOpen" class="switcher-overlay" @mousedown.self="close">
    <div class="switcher" role="dialog" aria-label="Find a note">
      <input
        ref="input"
        v-model="query"
        class="switcher-input"
        type="text"
        placeholder="Find a note or image…"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <ul v-if="results.length" ref="list" class="switcher-results scroll-area">
        <li
          v-for="(entry, i) in results"
          :key="entry.path"
          :class="{ selected: i === selected }"
          @mousemove="selected = i"
          @click="openNote(entry.path)"
        >
          <FileIcon :kind="isPdfPath(entry.path) ? 'pdf' : isImagePath(entry.path) ? 'image' : 'note'" />
          <span class="switcher-title">{{ entry.title }}</span>
          <span v-if="folderOf(entry.path)" class="switcher-folder">{{ folderOf(entry.path) }}</span>
        </li>
      </ul>
      <p v-else class="switcher-empty">Nothing found</p>
    </div>
  </div>
</template>

<style scoped>
.switcher-overlay {
  position: fixed;
  inset: 0;
  z-index: 80; /* above menus, below the confirmation and reload popups */
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 15vh;
  background: rgba(0, 0, 0, 0.45);
}

.switcher {
  width: min(32rem, calc(100vw - 2rem));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-background-mute);
  border: 1px solid rgb(var(--tint) / 0.08);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.switcher-input {
  flex-shrink: 0;
  padding: 0.75rem 1rem;
  font: inherit;
  font-size: 1rem;
  color: var(--color-text-strong);
  background: transparent;
  border: none;
  border-bottom: 1px solid rgb(var(--tint) / 0.08);
  outline: none;
}

.switcher-results {
  list-style: none;
  margin: 0;
  padding: 0.35rem;
  overflow-y: auto;
}

.switcher-results li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.45rem 0.65rem;
  font-size: 0.9rem;
  border-radius: 4px;
  cursor: pointer;
}

.switcher-results li.selected {
  background: rgb(var(--tint) / 0.1);
}

.switcher-title {
  flex: 1;
  overflow-wrap: anywhere;
}

.switcher-folder {
  flex-shrink: 0;
  font-size: 0.75rem;
  opacity: 0.5;
}

.switcher-empty {
  padding: 0.9rem 1rem;
  font-size: 0.85rem;
  opacity: 0.6;
}
</style>
