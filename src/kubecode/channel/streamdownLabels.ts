import type { StreamdownProps } from 'streamdown'

import type { Translator } from '@/lib/i18n'

/**
 * Copy controls on tables and code (ADR 0242): copying only, never a download
 * or a full-screen view, and each label from the locale catalogs.
 */
export const CONVERSATION_CONTROLS = {
  table: { copy: true, download: false, fullscreen: false },
  code: { copy: true, download: false },
  mermaid: false,
  image: false,
} satisfies StreamdownProps['controls']

/** streamdown's own words for the controls Kubecode shows, in the app's language. */
export function streamdownTranslations(t: Translator): NonNullable<StreamdownProps['translations']> {
  return {
    copied: t('kubecode.markdown.copied'),
    copyCode: t('kubecode.markdown.copyCode'),
    copyTable: t('kubecode.markdown.copyTable'),
    copyTableAsCsv: t('kubecode.markdown.copyTableAsCsv'),
    copyTableAsMarkdown: t('kubecode.markdown.copyTableAsMarkdown'),
    copyTableAsTsv: t('kubecode.markdown.copyTableAsTsv'),
    tableFormatCsv: t('kubecode.markdown.formatCsv'),
    tableFormatMarkdown: t('kubecode.markdown.formatMarkdown'),
    tableFormatTsv: t('kubecode.markdown.formatTsv'),
    imageNotAvailable: t('kubecode.markdown.imageNotAvailable'),
  }
}
