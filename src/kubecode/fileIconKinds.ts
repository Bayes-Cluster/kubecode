export type FileIconKind = 'code' | 'config' | 'document' | 'image' | 'file'

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx', 'kt',
  'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue',
])
const CONFIG_EXTENSIONS = new Set(['json', 'toml', 'yaml', 'yml'])
const DOCUMENT_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'txt'])
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])

export function fileIconKind(name: string): FileIconKind {
  const extension = name.toLocaleLowerCase().split('.').at(-1) ?? ''
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (CONFIG_EXTENSIONS.has(extension)) return 'config'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'file'
}
