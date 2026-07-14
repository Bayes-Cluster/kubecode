import { useState, useRef, useEffect, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { EMOJI_GROUPS, EMOJIS_BY_GROUP, GROUP_SHORT_LABELS, searchEmojis, type EmojiEntry } from '../utils/emoji'

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

function EmojiOptionButton({ entry, onSelect }: { entry: EmojiEntry; onSelect: (emoji: string) => void }) {
  return (
    <button
      type="button"
      key={entry.emoji}
      className="flex h-8 w-8 items-center justify-center rounded text-xl transition-colors hover:bg-accent"
      onClick={() => onSelect(entry.emoji)}
      title={entry.name}
      data-testid="emoji-option"
    >
      {entry.emoji}
    </button>
  )
}

function EmojiSearchResults({
  entries,
  onSelect,
}: {
  entries: EmojiEntry[]
  onSelect: (emoji: string) => void
}) {
  if (entries.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No emojis found
      </div>
    )
  }

  return (
    <div className="grid grid-cols-8 gap-0.5">
      {entries.map(entry => <EmojiOptionButton key={entry.emoji} entry={entry} onSelect={onSelect} />)}
    </div>
  )
}

function EmojiGroupSection({
  group,
  onSelect,
}: {
  group: string
  onSelect: (emoji: string) => void
}) {
  const emojis = EMOJIS_BY_GROUP.get(group)
  if (!emojis?.length) return null
  const label = (Reflect.get(GROUP_SHORT_LABELS, group) as string | undefined) ?? group

  return (
    <div>
      <div className="sticky top-0 z-10 bg-popover px-1 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
        {label}
      </div>
      <div className="grid grid-cols-8 gap-0.5">
        {emojis.map(entry => <EmojiOptionButton key={entry.emoji} entry={entry} onSelect={onSelect} />)}
      </div>
    </div>
  )
}

function EmojiGroupedResults({ onSelect }: { onSelect: (emoji: string) => void }) {
  return EMOJI_GROUPS.map(group => (
    <EmojiGroupSection key={group} group={group} onSelect={onSelect} />
  ))
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  // Close when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const handleSelect = useCallback((emoji: string) => {
    onSelect(emoji)
    onClose()
  }, [onSelect, onClose])

  const searchResults = search.trim() ? searchEmojis(search) : null
  const isSearching = searchResults !== null

  return (
    <div
      ref={containerRef}
      className="absolute z-50 w-[340px] rounded-lg border border-[var(--border-dialog)] bg-popover shadow-lg"
      style={{ left: 54, top: 0 }}
      data-testid="emoji-picker"
    >
      <div className="border-b border-border px-3 py-2">
        <Input
          ref={inputRef}
          type="text"
          className="h-8 border-0 bg-transparent px-0 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          placeholder="Search emoji by name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          data-testid="emoji-picker-search"
        />
      </div>
      <div ref={scrollRef} className="max-h-[300px] overflow-y-auto p-2" data-testid="emoji-picker-grid">
        {isSearching ? (
          <EmojiSearchResults entries={searchResults} onSelect={handleSelect} />
        ) : (
          <EmojiGroupedResults onSelect={handleSelect} />
        )}
      </div>
    </div>
  )
}
