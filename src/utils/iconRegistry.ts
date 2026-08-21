import type { ComponentType, SVGAttributes } from 'react'
import {
  Book, Bot, Brain, Bug, Calendar, Check, Circle, CircleCheck, Clock, Code, Database, File,
  FileCode, FileText, FlaskConical, Folder, Heart, Home, Layers, Lightbulb, ListChecks, Moon,
  Pencil, Puzzle, RefreshCw, Rocket, Search, Settings, Sparkle, SquareTerminal, Star, StickyNote,
  Sun, Tag, Target, Trash2, User, Users, Wrench, Zap,
} from 'lucide-react'

export type IconProps = SVGAttributes<SVGSVGElement> & { size?: number | string }
export type IconEntry = { name: string; Icon: ComponentType<IconProps> }

/**
 * Lucide-backed shim for the legacy note-icon registry (ADR 0209).
 *
 * Persisted vault frontmatter stores kebab-case icon names from the retired
 * Phosphor registry. This shim keeps that contract: a curated subset of names
 * resolves to lucide equivalents, and anything else falls back to FileText via
 * `resolveIcon`. New UI code must not import from here; use the icon
 * primitives in `src/kubecode/icons/`.
 */
export const ICON_OPTIONS: IconEntry[] = [
  { name: 'arrows-clockwise', Icon: RefreshCw },
  { name: 'book', Icon: Book },
  { name: 'brain', Icon: Brain },
  { name: 'bug', Icon: Bug },
  { name: 'calendar-blank', Icon: Calendar },
  { name: 'check', Icon: Check },
  { name: 'check-circle', Icon: CircleCheck },
  { name: 'circle', Icon: Circle },
  { name: 'clock', Icon: Clock },
  { name: 'code', Icon: Code },
  { name: 'database', Icon: Database },
  { name: 'file', Icon: File },
  { name: 'file-code', Icon: FileCode },
  { name: 'file-text', Icon: FileText },
  { name: 'flask', Icon: FlaskConical },
  { name: 'folder', Icon: Folder },
  { name: 'gear', Icon: Settings },
  { name: 'heart', Icon: Heart },
  { name: 'house', Icon: Home },
  { name: 'lightbulb', Icon: Lightbulb },
  { name: 'lightning', Icon: Zap },
  { name: 'list-checks', Icon: ListChecks },
  { name: 'magnifying-glass', Icon: Search },
  { name: 'moon', Icon: Moon },
  { name: 'note', Icon: StickyNote },
  { name: 'pencil', Icon: Pencil },
  { name: 'person', Icon: User },
  { name: 'puzzle-piece', Icon: Puzzle },
  { name: 'robot', Icon: Bot },
  { name: 'rocket', Icon: Rocket },
  { name: 'sparkle', Icon: Sparkle },
  { name: 'stack-simple', Icon: Layers },
  { name: 'star', Icon: Star },
  { name: 'sun', Icon: Sun },
  { name: 'tag', Icon: Tag },
  { name: 'target', Icon: Target },
  { name: 'terminal', Icon: SquareTerminal },
  { name: 'trash', Icon: Trash2 },
  { name: 'users', Icon: Users },
  { name: 'wrench', Icon: Wrench },
]

const ICON_MAP: Record<string, ComponentType<IconProps>> = Object.fromEntries(
  ICON_OPTIONS.map((o) => [o.name, o.Icon]),
)

function normalizeIconName(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

/** Resolves a persisted icon name to its lucide component, without a fallback. */
export function findIcon(name: string | null | undefined): ComponentType<IconProps> | null {
  if (!name) return null
  return ICON_MAP[normalizeIconName(name)] ?? null
}

/** Resolves a persisted icon name to its lucide component, with fallback to FileText */
export function resolveIcon(name: string | null): ComponentType<IconProps> {
  return findIcon(name) ?? FileText
}
