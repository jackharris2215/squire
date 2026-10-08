<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SERVER_URL } from './api'
import { allBlocks, isImagePath, isPdfPath, nameFromPath, noteCache, selectedFile } from './store'

// The right panel's note info tab: read-only facts about the note or image in the
// focused pane. Counts come from the note itself (reactive, so they track unsaved
// edits) and don't apply to an image; created/modified/size come from the server's
// file-info either way, re-fetched whenever the open file changes.
const note = computed(() => (selectedFile.value ? (noteCache.get(selectedFile.value) ?? null) : null))
// An image or a PDF: a file with no note content, so only the file facts apply.
const image = computed(() => !!selectedFile.value && (isImagePath(selectedFile.value) || isPdfPath(selectedFile.value)))

const name = computed(() => (selectedFile.value ? nameFromPath(selectedFile.value) : ''))

// The note's folder, notebook-relative; "(root)" if it isn't in one.
const location = computed(() => {
  const path = selectedFile.value
  if (!path) return ''
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '(root)' : path.slice(0, slash)
})

const blockCount = computed(() => (note.value ? allBlocks(note.value).length : 0))

const characterCount = computed(() => (note.value ? allBlocks(note.value).reduce((sum, b) => sum + b.content.length, 0) : 0))

const wordCount = computed(() => {
  if (!note.value) return 0
  let count = 0
  for (const block of allBlocks(note.value)) {
    // Words are runs of letters and digits; this skips markdown symbols like
    // table pipes and dividers, and entities such as &#124;.
    const text = block.content.replace(/&#?\w+;/g, ' ')
    count += text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0
  }
  return count
})

const fileInfo = ref<{ created: number; modified: number; size: number } | null>(null)

async function loadFileInfo() {
  const path = selectedFile.value
  fileInfo.value = null
  if (!path) return
  try {
    const res = await fetch(`${SERVER_URL}/file-info?path=${encodeURIComponent(path)}`)
    if (res.ok && selectedFile.value === path) fileInfo.value = await res.json()
  } catch {
    // Server unreachable: the facts just stay blank.
  }
}

watch(selectedFile, loadFileInfo, { immediate: true })

function formatTime(ms: number | undefined) {
  return ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

function formatSize(bytes: number | undefined) {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const STATS = computed(() => [
  { label: 'Created', value: formatTime(fileInfo.value?.created) },
  { label: 'Last modified', value: formatTime(fileInfo.value?.modified) },
  { label: 'File size', value: formatSize(fileInfo.value?.size) },
  ...(image.value
    ? []
    : [
        { label: 'Word count', value: String(wordCount.value) },
        { label: 'Character count', value: String(characterCount.value) },
        { label: 'Block count', value: String(blockCount.value) },
      ]),
])
</script>

<template>
  <div class="note-info scroll-area">
    <p v-if="!note && !image" class="info-hint">Open a note or image to see its info.</p>
    <template v-else>
      <div class="info-header">
        <p class="info-name">{{ name }}</p>
        <p class="info-location">{{ location }}</p>
      </div>
      <dl class="info-stats">
        <template v-for="stat in STATS" :key="stat.label">
          <dt class="info-label">{{ stat.label }}</dt>
          <dd class="info-value">{{ stat.value }}</dd>
        </template>
      </dl>
    </template>
  </div>
</template>

<style scoped>
.note-info {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.75rem;
}

.info-hint {
  padding: 0.25rem 0.4rem;
  font-size: 0.8rem;
  color: var(--color-text);
  opacity: 0.6;
}

.info-header {
  margin-bottom: 0.75rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--color-border-hover);
}

.info-name {
  margin: 0 0 0.15rem;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--color-text-strong);
  word-break: break-word;
}

.info-location {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text);
  opacity: 0.6;
  word-break: break-word;
}

.info-stats {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.75rem;
  row-gap: 0.55rem;
  margin: 0;
}

.info-label {
  font-size: 0.75rem;
  color: var(--color-text);
  opacity: 0.7;
  white-space: nowrap;
}

.info-value {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-text-strong);
  text-align: right;
  word-break: break-word;
}
</style>
