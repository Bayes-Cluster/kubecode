import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const failures = []
const markdownFiles = [
  join(root, 'README.md'),
  join(root, 'README.zh-CN.md'),
  ...walk(join(root, 'docs')).filter((path) => extname(path) === '.md'),
  join(root, 'CONTRIBUTING.md'),
  join(root, 'SECURITY.md'),
]

const localTargetPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|<(?:img|a)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/g
const privatePathPattern = /(?:\/Users\/[^/\s]+|\/var\/folders\/|NSIRD_screencaptureui_|TemporaryItems)/

for (const path of markdownFiles) {
  const source = readFileSync(path, 'utf8')
  if (privatePathPattern.test(source)) {
    failures.push(`${display(path)} contains a private or temporary local path`)
  }

  for (const match of source.matchAll(localTargetPattern)) {
    const rawTarget = match[1] ?? match[2]
    if (!rawTarget || isRemote(rawTarget)) continue
    const fileTarget = rawTarget.split('#', 1)[0].split('?', 1)[0]
    if (!fileTarget) continue
    const decoded = decodeURIComponent(fileTarget)
    const resolved = resolve(dirname(path), decoded)
    if (!resolved.startsWith(`${root}${sep}`) && resolved !== root) {
      failures.push(`${display(path)} links outside the repository: ${rawTarget}`)
    } else if (!existsSync(resolved)) {
      failures.push(`${display(path)} has a missing local target: ${rawTarget}`)
    }
  }
}

const englishGuides = readdirSync(join(root, 'docs/guides'))
  .filter((name) => name.endsWith('.md'))
  .sort()
const chineseGuides = readdirSync(join(root, 'docs/zh-CN/guides'))
  .filter((name) => name.endsWith('.md'))
  .sort()
if (englishGuides.join('\n') !== chineseGuides.join('\n')) {
  failures.push('English and Simplified Chinese user-guide filenames do not match')
}

requireText('README.md', './README.zh-CN.md')
requireText('README.zh-CN.md', './README.md')
requireText('docs/README.md', 'zh-CN/README.md')
requireText('docs/zh-CN/README.md', '../README.md')

for (const asset of [
  'public/logo.svg',
  'public/favicon.svg',
  'docs/assets/brand/kubecode-mark-light.svg',
  'docs/assets/brand/kubecode-mark-dark.svg',
  'docs/assets/brand/kubecode-social-preview.svg',
]) {
  const source = readFileSync(join(root, asset), 'utf8')
  if (!source.includes('<svg') || !source.includes('viewBox=')) {
    failures.push(`${asset} is not a responsive SVG`)
  }
  if (/data:image|<script\b/i.test(source)) {
    failures.push(`${asset} contains embedded image data or script content`)
  }
}

for (const asset of [
  'docs/assets/brand/kubecode-mark-512.png',
  'docs/assets/brand/kubecode-social-preview.png',
]) {
  const source = readFileSync(join(root, asset))
  const pngSignature = source.subarray(0, 8).toString('hex')
  if (pngSignature !== '89504e470d0a1a0a') {
    failures.push(`${asset} is not a valid PNG asset`)
  }
}

if (failures.length > 0) {
  console.error('Documentation validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Documentation validation passed (${markdownFiles.length} Markdown files, `
  + `${englishGuides.length} bilingual user guides).`,
)

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function isRemote(target) {
  return target.startsWith('#')
    || target.startsWith('http://')
    || target.startsWith('https://')
    || target.startsWith('mailto:')
}

function display(path) {
  return relative(root, path)
}

function requireText(path, expected) {
  const source = readFileSync(join(root, path), 'utf8')
  if (!source.includes(expected)) {
    failures.push(`${path} must contain ${expected}`)
  }
}
