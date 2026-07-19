import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

const remoteSchemePattern = /^[a-z][a-z\d+.-]*:/i
const markdownExtensionPattern = /^\.(?:md|markdown)$/i

export function markdownAnchors(source) {
  const anchors = new Set()
  const occurrences = new Map()
  const lines = source.split(/\r?\n/)
  let fenced = false
  let fenceMarker = ''

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[1][0]
      if (!fenced) {
        fenced = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        fenced = false
        fenceMarker = ''
      }
      continue
    }
    if (fenced) continue

    for (const match of line.matchAll(/<[^>]+\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
      anchors.add(match[1])
    }

    const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/)
    if (atx) {
      addHeadingAnchor(anchors, occurrences, atx[1])
      continue
    }

    const nextLine = lines[index + 1] ?? ''
    if (line.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/.test(nextLine)) {
      addHeadingAnchor(anchors, occurrences, line.trim())
      index += 1
    }
  }

  return anchors
}

export function validateLocalMarkdownTarget(root, sourcePath, rawTarget) {
  if (!rawTarget || isRemoteTarget(rawTarget)) return null

  const hashIndex = rawTarget.indexOf('#')
  const targetBeforeFragment = hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget
  const rawFragment = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1) : ''
  const queryIndex = targetBeforeFragment.indexOf('?')
  const rawFileTarget = queryIndex >= 0
    ? targetBeforeFragment.slice(0, queryIndex)
    : targetBeforeFragment

  let decodedFileTarget
  let decodedFragment
  try {
    decodedFileTarget = decodeURIComponent(rawFileTarget)
    decodedFragment = decodeURIComponent(rawFragment)
  } catch {
    return `has invalid URL encoding: ${rawTarget}`
  }

  const resolved = decodedFileTarget
    ? resolve(dirname(sourcePath), decodedFileTarget)
    : sourcePath
  const relativeTarget = relative(root, resolved)
  if (isAbsolute(relativeTarget)
      || relativeTarget === '..'
      || relativeTarget.startsWith(`..${sep}`)) {
    return `links outside the repository: ${rawTarget}`
  }
  if (!existsSync(resolved)) {
    return `has a missing local target: ${rawTarget}`
  }
  if (!decodedFragment || !isMarkdownPath(resolved)) return null

  const anchors = markdownAnchors(readFileSync(resolved, 'utf8'))
  if (!anchors.has(decodedFragment)) {
    return `has a missing anchor #${decodedFragment} in ${relativeTarget || '.'}: ${rawTarget}`
  }
  return null
}

function addHeadingAnchor(anchors, occurrences, rawHeading) {
  const base = githubHeadingSlug(markdownText(rawHeading))
  if (!base) return

  let slug = base
  let suffix = occurrences.get(base) ?? 0
  while (anchors.has(slug)) {
    suffix += 1
    slug = `${base}-${suffix}`
  }
  occurrences.set(base, suffix)
  anchors.add(slug)
}

function githubHeadingSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, '')
    .replace(/\s/g, '-')
}

function markdownText(value) {
  return value
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\[[^\]]*]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/_{2}([^_]+)_{2}/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/[`*~]/g, '')
}

function isRemoteTarget(target) {
  return target.startsWith('//') || remoteSchemePattern.test(target)
}

function isMarkdownPath(path) {
  return markdownExtensionPattern.test(extname(path))
}
