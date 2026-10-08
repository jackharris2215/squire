import { watchEffect } from 'vue'
import { config } from './store'
import type { Config } from './types'

// The Appearance settings: the options the settings page offers, and applying the
// chosen ones to the page. Everything is done through CSS variables and the
// data-theme attribute on <html> (see assets/base.css), so no component needs to know.

export const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const

export const DEFAULT_ACCENT = '#7ac08b'

export const ACCENT_PRESETS = [
  { value: DEFAULT_ACCENT, label: 'Green' },
  { value: '#7aa8d8', label: 'Blue' },
  { value: '#b392e0', label: 'Purple' },
  { value: '#e08aa8', label: 'Pink' },
  { value: '#e0b070', label: 'Amber' },
  { value: '#e08c6e', label: 'Orange' },
] as const

export const FONTS = [
  { value: 'default', label: 'Default', stack: null },
  { value: 'system', label: 'System', stack: "system-ui, 'Segoe UI', sans-serif" },
  { value: 'serif', label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
  { value: 'mono', label: 'Monospace', stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
] as const

export const NOTE_WIDTHS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
] as const

// Dark text on a light accent, light text on a dark one.
function textOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return (r! * 299 + g! * 587 + b! * 114) / 1000 > 140 ? '#1f2a22' : '#ffffff'
}

function applyAppearance(settings: Config, systemDark: boolean) {
  const root = document.documentElement
  const theme = settings.theme ?? 'system'
  root.dataset.theme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  const accent = settings.accentColor
  if (accent && /^#[0-9a-f]{6}$/i.test(accent) && accent.toLowerCase() !== DEFAULT_ACCENT) {
    root.style.setProperty('--color-accent', accent)
    root.style.setProperty('--color-on-accent', textOn(accent))
  } else {
    root.style.removeProperty('--color-accent')
    root.style.removeProperty('--color-on-accent')
  }

  const stack = FONTS.find((f) => f.value === settings.font)?.stack
  if (stack) root.style.setProperty('--font-app', stack)
  else root.style.removeProperty('--font-app')
}

// Applies the settings now and again whenever they change (or the system's light/dark
// preference does, for the System theme). Call once the config has loaded.
export function startAppearance() {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let systemDark = media.matches
  media.addEventListener('change', (event) => {
    systemDark = event.matches
    applyAppearance(config.value, systemDark)
  })
  watchEffect(() => applyAppearance(config.value, systemDark))
}
