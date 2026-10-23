---
type: ADR
id: "0254"
title: "Route audit closes the official-component migration"
status: accepted
date: 2026-10-23
---

## Context

Issue #263 (UI I, under #254) audits every production route after slices A–H
(#255–#262, ADRs 0247–0253) landed. The audit found, besides per-route visual
and accessibility defects:

- `components.json` declared the built-in `@shadcn` registry under
  `registries`. shadcn CLI 4.22.1 treats that name as reserved and rejects
  the whole file ("Invalid configuration"), so `shadcn info`, `add`,
  `--dry-run` and `--diff` failed in every worktree (noted in ADR 0253).
- 348 locale keys still held the English source text in up to 20 locales
  (265 in de-DE). `l10n:validate` passed because it only checked that keys
  and placeholders exist.
- About 980 locale keys from the retired notes application were no longer
  referenced by any source.
- `scripts/css-ownership-baseline.json` still listed 13 rules owned by merged
  slices, and `kubecode.css`/`index.css` carried rules nothing rendered.
- A few surfaces were still handcrafted next to official parts: the work
  board card (`article role=button`), the work inspector histories (raw
  `section/h4/ul/li`), the reply citation and failed-delivery line, and
  `ConversationIdentity`'s name button.

ADRs 0247–0253 are accepted and are not edited; this ADR records what changes
on top of them.

## Decision

1. **CLI configuration.** `components.json` lists only third-party
   registries (`@ai-elements`). `@shadcn` is the CLI's built-in registry and
   is never redeclared. `pnpm dlx shadcn@4.22.1 info` and
   `add <component> --dry-run` are the check that the configuration is valid
   (`docs/design/ui-shared-contract.md` §7).
2. **CSS ownership baseline.** The baseline holds only documented
   exceptions: overlay zoom compensation and no text selection on controls
   (app level), the xterm viewport (specialist engine) and
   `prefers-reduced-motion` (accessibility) — 10 entries. Every rule owned by
   a merged slice was removed rather than relabelled. The app has one
   scrollbar policy (thin, shown while hovered or focused); no region hides
   its scrollbar.
3. **Locales.** `scripts/validate-locales.mjs` also fails when a non-English
   value is identical to English and has three or more words, except for an
   explicit list of keys that read the same everywhere (a path, a shell
   command, a provider setting name). Keys no source references are removed
   from all 21 catalogs; `TranslationKey` is derived from `en.json`, so the
   type checker proves no typed caller remains.
4. **Card and list patterns.** A clickable board card is the official Card
   holding one native button (the TaskCardView pattern from #259); a history
   in an inspector is a named region holding an `ItemGroup` of `Item`s. A
   reader inside a titled host (an inspector panel) does not repeat the
   host's title, kind and version (`RecordPreview titledByHost`).
5. **Touch targets.** Small icon buttons that are not `IconButton`s carry
   `kubecode-touch-target`, which joins the coarse-pointer minimum size of
   ADR 0227 without touching the official Button variants.
6. **Inventory.** `docs/design/ui-migration-inventory.md` has no `partial` or
   `handcrafted` rows. Each remaining custom piece is an `exception` with its
   evidence, a `specialist-engine`, or `not-applicable`.

No dependency is added. `ws`, `@types/ws` and `esbuild` are removed from
`devDependencies` because nothing imports them (Vite brings its own esbuild).

## Consequences

- The shadcn CLI works again for diffs and updates of installed components.
- A future untranslated sentence fails `pnpm l10n:validate` instead of
  shipping English to every locale. Short labels that are legitimately the
  same in a language (for example "Agent", "Status", "Terminal") still pass.
- New CSS that reaches into official internals still fails `pnpm lint`; the
  baseline can only shrink.
- Remaining gaps are recorded in `docs/HANDOFF.md`, not hidden in the
  inventory: the Workspace search shows "changed since these results" after
  the project watcher's full rescans (`file_changed` with `full: true`), which
  needs a server-side change, and a narrow Session title bar still has little
  room below 360 px.
