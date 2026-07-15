import { describe, expect, it } from 'vitest'

import { terminalThemeFromStyles } from './terminalTheme'

describe('terminalThemeFromStyles', () => {
  it('maps the active workspace theme tokens into the xterm palette', () => {
    const tokens: Record<string, string> = {
      '--surface-editor': ' #282c34 ',
      '--text-primary': '#abb2bf',
      '--text-secondary': '#9da5b4',
      '--text-muted': '#5c6370',
      '--accent-blue': '#61afef',
      '--accent-blue-light': 'rgba(97, 175, 239, 0.16)',
      '--accent-red': '#e06c75',
      '--accent-green': '#98c379',
      '--accent-yellow': '#e5c07b',
      '--accent-purple': '#c678dd',
      '--accent-teal': '#56b6c2',
    }
    const styles = {
      getPropertyValue: (name: string) => tokens[name] ?? '',
    }

    expect(terminalThemeFromStyles(styles)).toMatchObject({
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#61afef',
      cursorAccent: '#282c34',
      selectionBackground: 'rgba(97, 175, 239, 0.16)',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      brightBlack: '#9da5b4',
    })
  })
})
