<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { answerDialog, dialog } from './dialog'

// The app's own confirmation popup. Escape or a click on the dimmed background
// cancels; the Cancel button starts focused so a stray Enter can't confirm.
const cancelButton = ref<HTMLButtonElement | null>(null)

watch(dialog, async (current) => {
  if (!current) return
  await nextTick()
  cancelButton.value?.focus()
})
</script>

<template>
  <div v-if="dialog" class="dialog-overlay" @mousedown.self="answerDialog(false)" @keydown.esc="answerDialog(false)">
    <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="dialog.title">
      <h2 class="dialog-title">{{ dialog.title }}</h2>
      <p class="dialog-message">{{ dialog.message }}</p>
      <div class="dialog-buttons">
        <button ref="cancelButton" class="dialog-button" @click="answerDialog(false)">Cancel</button>
        <button class="dialog-button danger" @click="answerDialog(true)">{{ dialog.confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 90; /* above menus, below the reload popup */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.dialog {
  width: min(24rem, calc(100vw - 2rem));
  padding: 1.25rem 1.5rem;
  color: var(--color-text-strong);
  background: var(--color-background-mute);
  border: 1px solid rgb(var(--tint) / 0.08);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.dialog-title {
  margin-bottom: 0.5rem;
  font-size: 1rem;
}

.dialog-message {
  margin-bottom: 1.25rem;
  font-size: 0.85rem;
  opacity: 0.85;
  overflow-wrap: anywhere;
}

.dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-button {
  font: inherit;
  font-size: 0.85rem;
  color: var(--color-text-strong);
  background: transparent;
  border: 1px solid var(--color-border-hover);
  border-radius: 6px;
  padding: 0.4rem 1rem;
  cursor: pointer;
}

.dialog-button:hover,
.dialog-button:focus-visible {
  border-color: var(--color-accent);
  outline: none;
}

.dialog-button.danger {
  color: #e08080;
  border-color: rgba(224, 128, 128, 0.4);
}

.dialog-button.danger:hover,
.dialog-button.danger:focus-visible {
  background: rgba(224, 128, 128, 0.12);
  border-color: #e08080;
}
</style>
