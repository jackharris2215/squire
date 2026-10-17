<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { folderOf } from './noteSearch'
import { isImagePath, isPdfPath } from './store'
import FileIcon from './FileIcon.vue'

// The autocomplete list shown at the cursor after typing [[. It only displays; the
// editor owns the keys and decides what picking does.
const props = defineProps<{
  items: { path: string; title: string }[]
  selected: number
  position: { left: number; top?: number; bottom?: number }
}>()

const emit = defineEmits<{ hover: [index: number]; pick: [entry: { path: string; title: string }] }>()

const list = ref<HTMLElement | null>(null)

watch(
  () => props.selected,
  async () => {
    await nextTick()
    list.value?.children[props.selected]?.scrollIntoView({ block: 'nearest' })
  },
)
</script>

<template>
  <ul
    ref="list"
    class="link-suggest scroll-area"
    :style="{
      left: position.left + 'px',
      top: position.top === undefined ? 'auto' : position.top + 'px',
      bottom: position.bottom === undefined ? 'auto' : position.bottom + 'px',
    }"
    @mousedown.prevent
  >
    <li
      v-for="(entry, i) in items"
      :key="entry.path"
      :class="{ selected: i === selected }"
      @mousemove="emit('hover', i)"
      @click="emit('pick', entry)"
    >
      <FileIcon :kind="isPdfPath(entry.path) ? 'pdf' : isImagePath(entry.path) ? 'image' : 'note'" />
      <span class="suggest-title">{{ entry.title }}</span>
      <span v-if="folderOf(entry.path)" class="suggest-folder">{{ folderOf(entry.path) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.link-suggest {
  position: fixed;
  z-index: 60;
  width: min(22rem, calc(100vw - 2rem));
  max-height: 14rem;
  margin: 0;
  padding: 0.3rem;
  overflow-y: auto;
  list-style: none;
  background: var(--color-background-mute);
  border: 1px solid rgb(var(--tint) / 0.08);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}

.link-suggest li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
  color: var(--color-text-strong);
  border-radius: 4px;
  cursor: pointer;
}

.link-suggest li.selected {
  background: rgb(var(--tint) / 0.1);
}

.suggest-title {
  flex: 1;
  overflow-wrap: anywhere;
}

.suggest-folder {
  flex-shrink: 0;
  font-size: 0.7rem;
  opacity: 0.5;
}
</style>
