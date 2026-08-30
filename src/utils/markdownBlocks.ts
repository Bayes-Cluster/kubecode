/**
 * Splits markdown content into stable blocks (#112): paragraph boundaries
 * outside code fences. The returned blocks are append-only for streaming —
 * only the tail block changes per delta, so all preceding blocks keep their
 * memo identity and skip re-rendering.
 */
export function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []
  const blocks: string[] = []
  let current = ''
  let fence: string | null = null
  const lines = content.split('\n')
  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)(```+|~~~+)/)
    if (fenceMatch) {
      if (fence && line.trimStart().startsWith(fence)) {
        fence = null
      } else if (!fence) {
        fence = fenceMatch[2].slice(0, 3)
      }
    }
    if (!fence && line.trim() === '' && current.trim() !== '') {
      blocks.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current.trim() !== '') blocks.push(current)
  return blocks
}
