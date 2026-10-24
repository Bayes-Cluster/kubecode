/**
 * Kubecode's streamdown configuration (ADR 0241), the one place markdown is
 * hardened for every surface (#278): raw HTML is never rendered, links and
 * images keep only safe protocols, and `$…$`/`$$…$$` math renders with
 * KaTeX. Mermaid is left out: diagrams are not a Workspace feature and the
 * renderer is large.
 */
import 'katex/dist/katex.min.css'

import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { harden } from 'rehype-harden'
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'

/** Links a reader may follow from agent-written markdown. */
export const SAFE_LINK_PROTOCOLS = ['http', 'https', 'mailto'] as const

export const STREAMDOWN_PLUGINS = {
  cjk,
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
} satisfies StreamdownProps['plugins']

/** Sanitize, then harden — never `rehype-raw`. */
export const STREAMDOWN_REHYPE_PLUGINS: NonNullable<StreamdownProps['rehypePlugins']> = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      // Prefix lists need a fixed origin; protocols alone decide here.
      allowedImagePrefixes: ['*'],
      allowedLinkPrefixes: ['*'],
      allowedProtocols: [...SAFE_LINK_PROTOCOLS],
      allowDataImages: false,
      defaultOrigin: undefined,
    },
  ],
]

/** Props every Kubecode streamdown surface spreads before its own. */
export const HARDENED_STREAMDOWN_PROPS = {
  plugins: STREAMDOWN_PLUGINS,
  rehypePlugins: STREAMDOWN_REHYPE_PLUGINS,
  skipHtml: true,
  linkSafety: { enabled: false },
  // Table and code copy/download buttons carry streamdown's English labels
  // as titles only; they return with localized `translations` in S1.
  controls: false,
} satisfies Partial<StreamdownProps>

/**
 * For previews of files and records the reader did not write (Resources, Add
 * context): same hardening, but no image is ever fetched. A remote image would
 * load on open, with no click, and could carry data out in its URL; it shows
 * as its alt text instead.
 */
export const NO_IMAGE_STREAMDOWN_PROPS = {
  ...HARDENED_STREAMDOWN_PROPS,
  rehypePlugins: [
    defaultRehypePlugins.sanitize,
    [
      harden,
      {
        allowedImagePrefixes: [],
        allowedLinkPrefixes: ['*'],
        allowedProtocols: [...SAFE_LINK_PROTOCOLS],
        allowDataImages: false,
        defaultOrigin: undefined,
        imageBlockPolicy: 'text-only',
      },
    ],
  ] as NonNullable<StreamdownProps['rehypePlugins']>,
} satisfies Partial<StreamdownProps>
