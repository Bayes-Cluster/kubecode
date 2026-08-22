---
type: ADR
id: "0209"
title: "Semantic icon system"
status: accepted
date: 2026-08-20
supersedes: "0189 (icon-system clause only)"
---

## Context

ADR 0189 states that "Phosphor icons use a shared 16-pixel regular-weight
baseline. Semantic file icons, small status dots, theme tokens, and theme
preview swatches communicate state without decorative color or product-specific
icon forks." That clause made Phosphor the only workbench icon source. In
practice the workbench now mixes several undeclared systems:

- File identity comes from `src/kubecode/fileIconKinds.ts`, a five-kind
  extension-set resolver (`code`, `config`, `document`, `image`, `file`) whose
  `config` kind renders the generic file glyph and whose only distinction is a
  CSS color. It knows nothing about file names, compound suffixes, or folders.
- Workflow state is communicated almost entirely by `data-status` CSS dots in
  `kubecode.css` (`.kubecode-navigator-status`, `.kubecode-team-member-status`,
  `.kubecode-session-plan-entry`), which are color-only signals.
- The legacy Tolaria registry `src/utils/iconRegistry.ts` imports about 289
  Phosphor icons. It is not dead code: it is reachable from the active runtime
  through `WorkbenchShell` → `SessionWorkspace` → `SessionComposer` →
  `ComposerContextInput` → `InlineWikilinkInput` → `InlineWikilinkParts` →
  `NoteTitleIcon` and `note-item/typeIcon`, so the full import list ships in
  the production bundle to resolve persisted kebab-case icon names.

A file icon catalog needs real file-type glyphs, and file identity must stay
independent of both Git state and the eleven workbench theme variants, which
retint `--accent-*` tokens.

## Decision

Kubecode adopts one semantic icon system. ADR 0189's icon clause is superseded;
its remaining decisions on layout hierarchy, status dots as the primary state
channel, and theme-token discipline remain in force.

### Sources

- `lucide-react` (ISC) is the default source for line icons in navigation,
  command, and control roles. Named imports keep each glyph tree-shakeable.
- `@remixicon/react` (Apache-2.0) is used only where a role calls for a filled
  glyph that lucide does not carry.
- Native emoji remain the note-identity vocabulary, rendered through a fixed
  24-pixel `<EmojiIcon>` container that validates its value against the
  existing `unicode-emoji-json` data and renders a deterministic identity-role
  fallback icon when the value is absent or not an emoji.
- Workflow status iconography is owned by `src/kubecode/icons/statusIcons.tsx`.
  Each Agent/Session run state, Team, plan, Git file state, connection, and
  notification state, plus Project/Team/provider identity, resolves to one
  shared definition. Agent identity keeps the independent
  `src/components/AiAgentIcon.tsx` brand SVG system, which remains out of scope.
- File and directory identity comes from an audited subset of the Material Icon
  Theme (`material-extensions/vscode-material-icon-theme`, MIT), vendored by a
  dev-time generator pinned to one upstream commit. The subset, its resolver,
  and its budget are described below.

### Sizes and roles

`src/kubecode/icons/index.ts` exports the ladder as one typed constant:

| Role | Pixels | Use |
| --- | --- | --- |
| `status` | 12 | status dots' icon cues, Git state markers |
| `secondary` | 14 | inline list and row suffixes |
| `default` | 16 | files, commands, most controls |
| `toolbar` | 20 | toolbar and panel actions |
| `identity` | 24 | emoji containers, identity slots |
| `hitTarget` | 28 | minimum pointer target for icon-only buttons |

`IconRole` is `'navigation' | 'command' | 'control' | 'status' | 'identity' |
'file'`. Call sites pick a size by role name, never by raw number. Icon
renderers emit the icon as the root `<svg>` element; workbench CSS sizes most
icons through descendant `svg` selectors, so no wrapper element may sit between
a row and its icon.

### Accessibility

An icon without a label is decorative: it renders `aria-hidden="true"`. An
icon-only control passes a `label`, which renders `role="img"`,
`aria-label`, and a tooltip via the shared tooltip primitives, with localized
copy from `en.json` and every `lara.yaml` locale. Every status icon definition
carries a documented non-color cue — a distinct glyph shape such as a check,
cross, clock, pause, or hand — and a family never distinguishes two states by
color alone. File identity icons are decorative; Git state is expressed by an
adjacent marker that follows the `data-status` convention and carries an
accessible name, never by recoloring the identity icon. Status dots remain the
primary state channel; status icons are a supplementary non-color cue.

### Material file icon catalog

`scripts/material-icons/generate.mjs` vendors an audited subset from one pinned
upstream commit. It is deterministic and idempotent, runs only at development
time, and never fetches at test or runtime. The audit list in
`scripts/material-icons/audit-list.json` caps the catalog at 128 icons and
records why each icon is vendored. The generator rewrites every upstream fill
hex to a `var(--material-*)` custom property, strips the outer `<svg>` tag so
the render layer can emit a root `<svg>`, and derives `-open` folder variants
by replacing the canonical folder path, mirroring the upstream build step.
Generic `file`, `folder`, `folder-open`, and `folder-root` glyphs are
Kubecode-authored baseline assets written directly with token fills. The
generated manifest and SVG files are committed; the upstream MIT notice and
pinned commit live in `scripts/material-icons/LICENSE`.

`resolveFileIcon` is a pure resolver. Files resolve by exact file name, then
compound suffix (longest match), then extension, then semantic fallback, then
the generic file icon. Directories resolve by name, then that name's open
variant, then the generic folder, then the generic open folder. All matching
is case-insensitive.

Material colors are independent of the workbench theme. `--material-*` tokens
are defined once per color scheme in the light and dark blocks of
`src/index.css` and are never aliased to `--accent-*`, so the eleven theme
variants cannot retint file icons. Icons whose upstream source has a light
variant render both bodies inside one root `<svg>`; CSS shows the matching
`data-variant` group from the document element's `data-theme` attribute and
`dark` class, so switching schemes requires no icon re-render and adds no
JavaScript theme dependency.

### Phased migration

Adoption is incremental and every phase leaves the build green:

1. This ADR and the supporting documents.
2. Icon primitives: the size ladder, the `<Icon>` wrapper, `<EmojiIcon>`.
3. The vendored Material catalog, resolver, and `--material-*` tokens.
4. Shared status and identity definitions with localized labels.
5. Surface adoption: file tree, path picker, editor and diff tabs, Git
   Changes rows, the diff toolbar, and composer references all resolve file
   identity through the same resolver; the old five-kind resolver and its
   renderers are deleted.
6. Phosphor retirement from `src/kubecode/**`, surface by surface, ending with
   removal of the Phosphor `IconContext` provider in `WorkbenchShell`.

Legacy persisted icon names continue to render throughout the migration: the
registry resolves known names to lucide equivalents and unknown names to a
documented fallback.

### Legacy registry retirement

`src/utils/iconRegistry.ts` is reduced to a minimal shim over lucide that
keeps its public surface (`IconProps`, `IconEntry`, `ICON_OPTIONS`,
`findIcon`, `resolveIcon`). It maps the note-type names still resolved by
`note-item/typeIcon` and a small curated slice of previously common persisted
names; every unknown kebab-case name resolves to the generic document glyph,
matching the registry's existing fallback behavior. The registry is retained
rather than deleted because the wikilink composer path is active runtime code
and persisted note frontmatter stores icon names that are resolved at render
time; the shim keeps that behavior without shipping the full Phosphor import
list.

The shadcn primitives under `src/components/ui/` that alias Phosphor imports
(`dropdown-menu`, `select`, `dialog`) are shared components outside this ADR's
migration scope. `@phosphor-icons/react` therefore remains a dependency until
those primitives migrate; no active `src/kubecode/**` module imports it.

## Consequences

- Only ADR 0189's icon clause is superseded; its layout, status-dot, and
  theme-token decisions remain in force.
- The workbench gains two new runtime dependencies (`lucide-react`,
  `@remixicon/react`) and one vendored, committed icon subset with its
  generator, audit list, and license notice.
- The Material manifest is a static object bounded by the audit cap; bundle
  growth is guarded by the cap and by generator consistency tests rather than
  by tree shaking.
- File identity becomes visually independent of Git state and of every
  workbench theme variant, and every workflow state is understandable without
  color.
- Persisted legacy icon names keep rendering through a bounded shim, and the
  approximately 280 previously bundled unused Phosphor icons leave the
  production bundle.
- Icon-only controls require localized labels in every locale, so new status
  vocabulary adds translation keys across the catalog.
