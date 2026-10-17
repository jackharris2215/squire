import type { Block } from './types'

// The colors a block can use. Subtle tints that fit the dark theme; 'default'
// leaves the theme's own text color / no background.
export const COLORS = [
  { key: 'default', label: 'Default', text: '', background: '' },
  { key: 'green', label: 'Green', text: '#7ac08b', background: 'rgba(122, 192, 139, 0.16)' },
  { key: 'amber', label: 'Amber', text: '#e0b070', background: 'rgba(224, 176, 112, 0.16)' },
  { key: 'red', label: 'Red', text: '#e08080', background: 'rgba(224, 128, 128, 0.16)' },
  { key: 'blue', label: 'Blue', text: '#7aa8d8', background: 'rgba(122, 168, 216, 0.16)' },
]

export const ALIGNMENTS = [
  { value: 'left', label: 'Align left', icon: 'M4 6h16M4 10h10M4 14h16M4 18h10' },
  { value: 'center', label: 'Align center', icon: 'M4 6h16M7 10h10M4 14h16M7 18h10' },
  { value: 'right', label: 'Align right', icon: 'M4 6h16M10 10h10M4 14h16M10 18h10' },
] as const

// Inline style for a block's display settings; a missing setting adds nothing.
export function blockStyle(block: Block) {
  const color = (key: string | undefined, field: 'text' | 'background') =>
    COLORS.find((c) => c.key === key)?.[field] || undefined
  return {
    textAlign: block.align,
    color: color(block.textColor, 'text'),
    backgroundColor: color(block.background, 'background'),
  }
}
