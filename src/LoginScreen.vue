<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { login, reloadPage } from './api'

// Shown instead of the app when the server asks for a password. Once it has accepted
// one, the page reloads and loads as normal.
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const input = ref<HTMLInputElement | null>(null)

onMounted(() => input.value?.focus())

async function submit() {
  if (busy.value || !password.value) return
  busy.value = true
  error.value = await login(password.value)
  busy.value = false
  if (error.value === null) reloadPage()
  else input.value?.select()
}
</script>

<template>
  <div class="login-screen">
    <form class="login-card" @submit.prevent="submit">
      <h1 class="login-title">Squire Notes</h1>
      <input
        ref="input"
        v-model="password"
        class="settings-input"
        type="password"
        placeholder="Password"
        autocomplete="current-password"
        @input="error = null"
      />
      <button class="login-button" type="submit" :disabled="busy || !password">Unlock</button>
      <p v-if="error" class="settings-error">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login-screen {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-background);
}

.login-card {
  width: min(20rem, calc(100vw - 2rem));
  padding: 1.5rem;
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
}

.login-title {
  margin: 0 0 1rem;
  font-size: 1.1rem;
  font-weight: 700;
  text-align: center;
  color: var(--color-text-strong);
}

.login-button {
  width: 100%;
  font: inherit;
  color: var(--color-on-accent);
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  padding: 0.5rem;
  cursor: pointer;
}

.login-button:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.login-button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
