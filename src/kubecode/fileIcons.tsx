import {
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
} from '@phosphor-icons/react'

import { fileIconKind } from './fileIconKinds'

export function ProjectEntryIcon({
  expanded = false,
  kind,
  name,
}: {
  expanded?: boolean
  kind: 'directory' | 'file'
  name: string
}) {
  if (kind === 'directory') {
    const DirectoryIcon = expanded ? FolderOpen : Folder
    return <DirectoryIcon className="kubecode-file-icon" data-kind="directory" />
  }
  const iconKind = fileIconKind(name)
  const EntryIcon = iconKind === 'code'
    ? FileCode
    : iconKind === 'document'
      ? FileText
      : iconKind === 'image'
        ? FileImage
        : File
  return <EntryIcon className="kubecode-file-icon" data-kind={iconKind} />
}
