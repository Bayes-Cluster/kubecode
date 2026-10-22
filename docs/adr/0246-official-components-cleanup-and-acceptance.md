---
type: ADR
id: "0246"
title: "Cleanup after the move to official components"
status: accepted
date: 2026-10-22
---

## Context

ADR 0241 moved the Workspace onto the official shadcn/ui components and AI
Elements in slices. S1 to S4 (ADRs 0242 to 0245) moved each surface. Several
cleanups were left for slice S5:

- hand-rolled components, CSS rules and locale keys that the slices left
  unused;
- dependencies that only unused official files imported;
- `dark:` following the app theme only inside official surfaces;
- motion that ignored `prefers-reduced-motion`;
- English labels in official files that Kubecode renders.

## Decision

### Removed

- **Components.** The hand-rolled `Composer` and `RecipientRow` in
  `src/components/workspace/` and their tests. The product composes on
  `ConversationComposer` (Prompt Input, ADR 0242), so the `#/controls` matrix
  drops its hand-rolled composer section. Its official-components section
  already shows the composer as Prompt Input, in the longest locale.
  `DecisionButton`, `IconButton`, `SendButton`, `StatusBadge`,
  `ReferenceChip`, `MemberIdentity`, `MoreActions` and `ViewHeader` stay
  because product surfaces still render them.
- **Official files that nothing renders.** `ui/bubble`, `ui/marker`,
  `ui/message-scroller` and `ui/sonner`. With them go the `sonner`,
  `next-themes` and `@shadcn/react` dependencies. `embla-carousel-react`
  (Inline Citation), `tokenlens` (Context), `nanoid` (Prompt Input) and `cn`
  (the new `ui` files) stay because their official files are still imported.
- **CSS.** 76 selectors over 41 `kubecode-*`/`ai-*` classes that no source or
  test file names, literally or as a built class prefix. A rule that also
  lists a live selector keeps that selector. This removes the old
  `ai-action-card` caption parts and `kubecode-detail-facts`,
  `kubecode-work-evidence-text`, `kubecode-recipient*` and
  `kubecode-composer-to-*`. The sweep also repairs a merge left in
  `kubecode.css` by S4: a lost comment opener, a stray `=======` line and an
  unclosed trailing comment. Together they had disabled the first rules of
  the S4 and S2 blocks.
- **Locale keys.** 78 `kubecode.*` keys that no source, test, script or
  server file names, from `en.json` and every locale. Keys that are built
  from a literal prefix (``t(`kubecode.work.stage.${stage}`)`` and the like)
  are kept. Older non-`kubecode` keys that are unreferenced are out of scope.

### Changed

- **Theme.** Tailwind's `dark:` variant follows `[data-theme='dark']`
  everywhere (`index.css`). `themeMode.ts` always writes the resolved theme,
  so the system preference still applies through `data-theme`.
- **Reduced motion.** `src/lib/reducedMotion.ts` reads
  `prefers-reduced-motion`. `Shimmer` renders still, muted text when motion
  is reduced. `Conversation` and `ConversationScrollButton` scroll instantly,
  and the Session view's jump to latest uses `auto` instead of `smooth`.
- **Labels.** `PromptInput` takes `uploadLabel` for its hidden file input,
  which every composer renders. Callers pass `kubecode.vocab.command.attachFile`.
  Every other English default in an official file is either overridden at
  each call site or not rendered.

The new edits to official files carry `Kubecode (ADR 0246)` comments, as
ADR 0241 §1 asks.

### Still deferred

- `InlineCitation` stays prototype-only until the server provides citation
  spans (ADR 0236). Its carousel labels get props when it ships.
- `@ai-elements/terminal`, `@ai-elements/stack-trace`, `@ai-elements/subagent`
  and `@shadcn/trace` are still unpublished (ADR 0245).
- Select menus portalled outside an official subtree still use the global
  shadcn aliases (ADR 0244).
- `WorkspaceSearch` keeps its own combobox (ADR 0244).
- The #229 walkthrough at every width, in both themes and in de-DE runs
  separately with fixtures. It is not part of this change.

## Consequences

- The control matrix no longer shows recipient chips. The product has no
  recipient row; mentions are written in the text.
- Readers who ask for reduced motion see no shimmer and no animated scrolling.
- `dark:` utilities on non-official surfaces now follow the app's theme
  setting, not the OS setting, when the two differ.
- Upgrading `prompt-input`, `shimmer` or `conversation` with the CLI must keep
  the ADR 0246 edits.
