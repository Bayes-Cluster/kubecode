import {
  ArrowLeft,
  ArrowUp,
  AtSign,
  BellDot,
  BookPlus,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  ExternalLink,
  FileCheck2,
  FileText,
  FlaskConical,
  Hash,
  History,
  Library,
  Lightbulb,
  Link,
  ListFilter,
  ListTodo,
  MessageCircle,
  MessageCirclePlus,
  MessageSquareQuote,
  MessageSquareText,
  MessagesSquare,
  Package,
  PanelRightOpen,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  Reply,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Square,
  SquareCheckBig,
  SquareKanban,
  SquareTerminal,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react'

import type { TranslationKey } from '@/lib/i18n'

import type { IconSource } from './Icon'

/**
 * One meaning, one glyph, one name (ADR 0227). Views pick an entry by what it
 * means, never a glyph by its name; the label key names it in every locale.
 */
export type WorkspaceIconEntry = {
  Icon: IconSource
  labelKey: TranslationKey
}

/** Where the researcher can go in a Workspace. */
export const WORKSPACE_DESTINATION_ICONS = {
  general: { Icon: Hash, labelKey: 'kubecode.vocab.destination.general' },
  board: { Icon: SquareKanban, labelKey: 'kubecode.vocab.destination.board' },
  resources: { Icon: Library, labelKey: 'kubecode.vocab.destination.resources' },
  needsYou: { Icon: BellDot, labelKey: 'kubecode.vocab.destination.needsYou' },
  members: { Icon: Users, labelKey: 'kubecode.vocab.destination.members' },
  directMessage: { Icon: MessageCircle, labelKey: 'kubecode.vocab.destination.directMessage' },
  history: { Icon: History, labelKey: 'kubecode.vocab.destination.history' },
} as const satisfies Record<string, WorkspaceIconEntry>

/** What the researcher can do. */
export const WORKSPACE_COMMAND_ICONS = {
  send: { Icon: ArrowUp, labelKey: 'kubecode.vocab.command.send' },
  stopRun: { Icon: Square, labelKey: 'kubecode.vocab.command.stopRun' },
  pauseOrchestration: { Icon: Pause, labelKey: 'kubecode.vocab.command.pauseOrchestration' },
  resumeOrchestration: { Icon: Play, labelKey: 'kubecode.vocab.command.resumeOrchestration' },
  reply: { Icon: Reply, labelKey: 'kubecode.vocab.command.reply' },
  mention: { Icon: AtSign, labelKey: 'kubecode.vocab.command.mention' },
  addContext: { Icon: BookPlus, labelKey: 'kubecode.vocab.command.addContext' },
  attachFile: { Icon: Paperclip, labelKey: 'kubecode.vocab.command.attachFile' },
  inspect: { Icon: PanelRightOpen, labelKey: 'kubecode.vocab.command.inspect' },
  close: { Icon: X, labelKey: 'kubecode.vocab.command.close' },
  back: { Icon: ArrowLeft, labelKey: 'kubecode.vocab.command.back' },
  more: { Icon: Ellipsis, labelKey: 'kubecode.vocab.command.more' },
  share: { Icon: Share2, labelKey: 'kubecode.vocab.command.share' },
  retry: { Icon: RotateCcw, labelKey: 'kubecode.vocab.command.retry' },
  edit: { Icon: Pencil, labelKey: 'kubecode.vocab.command.edit' },
  remove: { Icon: Trash2, labelKey: 'kubecode.vocab.command.remove' },
  search: { Icon: Search, labelKey: 'kubecode.vocab.command.search' },
  filter: { Icon: ListFilter, labelKey: 'kubecode.vocab.command.filter' },
  copyLink: { Icon: Link, labelKey: 'kubecode.vocab.command.copyLink' },
  openElsewhere: { Icon: ExternalLink, labelKey: 'kubecode.vocab.command.openElsewhere' },
  newDirectMessage: { Icon: MessageCirclePlus, labelKey: 'kubecode.vocab.command.newDirectMessage' },
  expand: { Icon: ChevronDown, labelKey: 'kubecode.vocab.command.expand' },
  collapse: { Icon: ChevronUp, labelKey: 'kubecode.vocab.command.collapse' },
  settings: { Icon: Settings, labelKey: 'kubecode.vocab.command.settings' },
  add: { Icon: Plus, labelKey: 'kubecode.vocab.command.add' },
} as const satisfies Record<string, WorkspaceIconEntry>

/** What a reference or a row is about. */
export const WORKSPACE_OBJECT_ICONS = {
  task: { Icon: SquareCheckBig, labelKey: 'kubecode.vocab.object.task' },
  evidence: { Icon: FileCheck2, labelKey: 'kubecode.vocab.object.evidence' },
  file: { Icon: FileText, labelKey: 'kubecode.vocab.object.file' },
  finding: { Icon: Lightbulb, labelKey: 'kubecode.vocab.object.finding' },
  experiment: { Icon: FlaskConical, labelKey: 'kubecode.vocab.object.experiment' },
  artifact: { Icon: Package, labelKey: 'kubecode.vocab.object.artifact' },
  discussion: { Icon: MessagesSquare, labelKey: 'kubecode.vocab.object.discussion' },
  member: { Icon: UserRound, labelKey: 'kubecode.vocab.object.member' },
  message: { Icon: MessageSquareQuote, labelKey: 'kubecode.vocab.object.message' },
  thread: { Icon: MessageSquareText, labelKey: 'kubecode.vocab.object.thread' },
  session: { Icon: SquareTerminal, labelKey: 'kubecode.vocab.object.session' },
  workItem: { Icon: ListTodo, labelKey: 'kubecode.vocab.object.workItem' },
} as const satisfies Record<string, WorkspaceIconEntry>

export type WorkspaceDestination = keyof typeof WORKSPACE_DESTINATION_ICONS
export type WorkspaceCommand = keyof typeof WORKSPACE_COMMAND_ICONS
export type WorkspaceObjectKind = keyof typeof WORKSPACE_OBJECT_ICONS
