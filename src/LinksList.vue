<script setup lang="ts">
import { computed } from 'vue'
import { allBlocks, imageIndex, nameFromPath, noteCache, noteIndex, selectFile, selectedFile } from './store'

// The right panel's Links tab: every note or image the focused note links to with
// [[...]] or embeds with ![[...]], in the order they first appear, deduplicated by
// path. A link that doesn't resolve to a file is still listed (greyed out, like a
// missing link renders inline) so a broken one is easy to spot, but isn't clickable.
const note = computed(() => (selectedFile.value ? (noteCache.get(selectedFile.value) ?? null) : null))

// Same pattern renderLinks (markdown.ts) uses to find links and strip an embed's
// |width suffix.
const LINK_RE = /\[\[([^\]]+)\]\]/g
const SIZED_RE = /^(.+)\|\s*(\d+)\s*$/

interface LinkEntry {
  title: string
  path: string | null // null if nothing in the notebook matches
}

const links = computed(() => {
  if (!note.value) return []
  const seen = new Set<string>()
  const entries: LinkEntry[] = []
  for (const block of allBlocks(note.value)) {
    for (const match of block.content.matchAll(LINK_RE)) {
      const inner = match[1]!
      const sized = SIZED_RE.exec(inner)
      const title = sized ? sized[1]! : inner
      const key = title.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const path = noteIndex.value[title] ?? imageIndex.value[title] ?? null
      entries.push({ title, path })
    }
  }
  return entries
})

function open(entry: LinkEntry) {
  if (entry.path) selectFile(entry.path)
}
</script>

<template>
  <div class="links-list scroll-area">
    <p v-if="!note" class="links-hint">Open a note to see its links.</p>
    <p v-else-if="links.length === 0" class="links-hint">This note doesn't link to anything yet.</p>
    <ul v-else class="link-items">
      <li
        v-for="entry in links"
        :key="entry.title"
        :class="{ missing: !entry.path, active: entry.path === selectedFile }"
        :title="entry.path ? nameFromPath(entry.path) : `${entry.title} doesn't exist yet`"
        @click="open(entry)"
      >
        {{ entry.title }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.links-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.5rem;
}

.links-hint {
  padding: 0.25rem 0.4rem;
  font-size: 0.8rem;
  color: var(--color-text);
  opacity: 0.6;
}

.link-items {
  list-style: none;
  padding: 0;
  margin: 0;
}

.link-items li {
  padding: 0.35rem 0.6rem;
  margin: 0.15rem 0;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
  overflow-wrap: break-word;
}

.link-items li:hover {
  background: rgb(var(--tint) / 0.06);
}

.link-items li.active {
  background: rgb(var(--tint) / 0.14);
}

.link-items li.missing {
  color: var(--color-text);
  opacity: 0.5;
  cursor: default;
}

.link-items li.missing:hover {
  background: transparent;
}
</style>
