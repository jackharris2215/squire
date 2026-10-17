<script setup lang="ts">
import { toggleRightPanel } from './store'

// The button that opens and closes the right panel; it sits in the top-right header.
</script>

<template>
  <button class="icon-button" title="Toggle right panel" aria-label="Toggle right panel" @click="toggleRightPanel">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  </button>
</template>
