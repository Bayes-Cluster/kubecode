import type { ITheme } from '@xterm/xterm'

type CssVariableReader = Pick<CSSStyleDeclaration, 'getPropertyValue'>

export function terminalThemeFromStyles(styles: CssVariableReader): ITheme {
  const background = token(styles, '--surface-editor', '#101118')
  const foreground = token(styles, '--text-primary', '#e5e5e5')
  const secondary = token(styles, '--text-secondary', '#a0a0a0')
  const muted = token(styles, '--text-muted', '#707070')
  const blue = token(styles, '--accent-blue', '#61afef')
  const red = token(styles, '--accent-red', '#e06c75')
  const green = token(styles, '--accent-green', '#98c379')
  const yellow = token(styles, '--accent-yellow', '#e5c07b')
  const magenta = token(styles, '--accent-purple', '#c678dd')
  const cyan = token(styles, '--accent-teal', '#56b6c2')

  return {
    background,
    foreground,
    cursor: blue,
    cursorAccent: background,
    selectionBackground: token(styles, '--accent-blue-light', 'rgba(97, 175, 239, 0.2)'),
    selectionForeground: foreground,
    black: muted,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: foreground,
    brightBlack: secondary,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
  }
}

function token(styles: CssVariableReader, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback
}
