import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  // In development the app is served by Vite, so the server's routes are forwarded to
  // it (prefixes: /file also covers /files and /file-info, /folder covers /folders and
  // /folder-rename). Built, the server serves the app itself and none of this applies.
  server: {
    proxy: Object.fromEntries(
      ['/file', '/folder', '/config', '/rename', '/move', '/image', '/events'].map((route) => [
        route,
        process.env.VITE_PROXY_TARGET ?? 'http://localhost:8765',
      ]),
    ),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
