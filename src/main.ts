import './assets/main.css'
import './assets/menus.css'

import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')

// The pass-through service worker (public/sw.js) that makes the app installable. Browsers
// only run it from a secure address (HTTPS, localhost, or one marked trusted in Chrome's
// flags); anywhere else this quietly does nothing.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
