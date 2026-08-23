import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MATERIAL_ICONS } from './manifest'
import { MaterialDirectoryIcon, MaterialFileIcon } from './materialIcons'

describe('MaterialFileIcon', () => {
  it('renders a root svg tagged with the icon id', () => {
    const { container } = render(<MaterialFileIcon id="typescript" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('data-material-icon')).toBe('typescript')
    expect(container.firstElementChild).toBe(svg)
  })

  it('defaults to the 16px file tier', () => {
    const { container } = render(<MaterialFileIcon id="typescript" />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('16')
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('16')
  })

  it('honors custom sizes for toolbar and picker rows', () => {
    const { container } = render(<MaterialFileIcon id="folder" size={18} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('18')
  })

  it('is decorative without a label and an image with one', () => {
    const plain = render(<MaterialFileIcon id="rust" />).container.querySelector('svg')
    expect(plain?.getAttribute('aria-hidden')).toBe('true')
    expect(plain?.getAttribute('role')).toBeNull()

    const labeled = render(<MaterialFileIcon id="rust" label="Rust source" />).container.querySelector('svg')
    expect(labeled?.getAttribute('role')).toBe('img')
    expect(labeled?.getAttribute('aria-label')).toBe('Rust source')
    expect(labeled?.getAttribute('aria-hidden')).toBeNull()
  })

  it('inlines a dark variant group for every icon', () => {
    const { container } = render(<MaterialFileIcon id="markdown" />)
    const group = container.querySelector('svg [data-variant="dark"]')
    const expectedPath = /d="([^"]+)"/.exec(MATERIAL_ICONS.markdown.dark)?.[1]
    // jsdom re-serializes self-closing tags; compare the geometry instead
    expect(group?.querySelector('path')?.getAttribute('d')).toBe(expectedPath)
    expect(group?.innerHTML).toContain('var(--material-blue-400)')
  })

  it('inlines the light variant group only when audited', () => {
    const withLight = render(<MaterialFileIcon id="pnpm" />).container
    expect(withLight.querySelector('[data-variant="light"]')).not.toBeNull()

    const withoutLight = render(<MaterialFileIcon id="toml" />).container
    // toml also has a light variant; assert a icon without one instead
    const solid = render(<MaterialFileIcon id="typescript" />).container
    expect(solid.querySelector('[data-variant="light"]')).toBeNull()
    expect(withoutLight.querySelector('[data-variant="dark"]')).not.toBeNull()
  })

  it('appends custom classNames after the material class', () => {
    const { container } = render(<MaterialFileIcon id="git" className="extra" />)
    const svg = container.querySelector('svg')
    expect(svg?.classList.contains('kubecode-material-icon')).toBe(true)
    expect(svg?.classList.contains('extra')).toBe(true)
  })
})

describe('MaterialDirectoryIcon', () => {
  it('resolves named directories and their open companions', () => {
    expect(
      render(<MaterialDirectoryIcon name="src" />).container.querySelector('svg')?.getAttribute('data-material-icon'),
    ).toBe('folder-src')
    expect(
      render(<MaterialDirectoryIcon name="src" expanded />).container.querySelector('svg')?.getAttribute('data-material-icon'),
    ).toBe('folder-src-open')
  })

  it('falls back to the generic folder baselines', () => {
    expect(
      render(<MaterialDirectoryIcon name="misc" />).container.querySelector('svg')?.getAttribute('data-material-icon'),
    ).toBe('folder')
    expect(
      render(<MaterialDirectoryIcon name="misc" expanded />).container.querySelector('svg')?.getAttribute('data-material-icon'),
    ).toBe('folder-open')
  })
})
