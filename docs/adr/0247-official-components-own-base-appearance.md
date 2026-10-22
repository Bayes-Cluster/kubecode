---
type: ADR
id: "0247"
title: "Official components own base appearance; shared contract for UI A–I"
status: accepted
date: 2026-10-22
---

## Context

ADRs 0241 to 0246 moved most surfaces onto the official shadcn/ui components
and AI Elements, but several earlier decisions kept a handcrafted presentation
next to them:

- ADR 0227 §3 defined the Workspace primitives (`StatusBadge`,
  `MemberAvatar`/`MemberIdentity`, `ReferenceChip`, `ViewHeader`,
  `MoreActions`, `DecisionButton`, `SendButton`/`StopButton`/`PauseButton`) as
  a standalone design drawn by `kubecode.css`. `StatusBadge` was a raw `span`.
- ADR 0233 §2 told AI Elements to compose those primitives "rather than
  restyling them", with `kubecode-ai-*` classes on the shared tokens, and
  excluded shadcn `Badge`, `Alert`, `Card` and others.
- ADR 0241 §5 themed the official components only inside elements marked
  `data-ws-components="official"`; outside them, and in portals opened from
  unmarked surfaces, the shadcn variables kept a second mapping.
- `components.json` named `phosphor` while the registry items and almost
  every call site used `lucide-react`.
- `kubecode.css` redraws official components through `[data-slot=…]`
  selectors, global `.kubecode-app [data-slot='button']` overrides and
  `!important`.

The #229 work claimed these surfaces complete. Issue #254 re-opens them in
nine slices (#255 A to #263 I); this ADR is slice A's shared decision.

## Decision

### 1. Official components own base appearance

An official shadcn/ui or AI Elements component owns its structure, states,
colours, typography, radii, shadows and internal layout. Product code chooses
a variant or size and passes layout classes (`className` for flex, gap, width,
margin). It does not restyle the component's internals. Completion claims
under #229 are not exemptions.

This supersedes ADR 0227 §3 (primitives as a standalone design), ADR 0233 §2
(shared conventions that excluded `Badge`, `Alert`, `Card` and kept
`kubecode-ai-*` restyling) and ADR 0241 §5 (theming scoped to
`data-ws-components`).

### 2. Wrappers are thin compositions

`src/components/workspace/` keeps only wrappers that carry a domain or
accessibility contract, each composed from official components:

| Wrapper | Composition | Contract it carries |
| --- | --- | --- |
| `StatusBadge` | `Badge`; tone → `success`/`info`/`warning`/`destructive`/`secondary` | words carry the meaning, tone never the only signal |
| `ReferenceChip` | `Badge` (outline) + `Button` (ghost) to open and remove | kind read before title, changed/removed/unavailable in words, never authorizes |
| `MemberAvatar`/`MemberIdentity` | `Avatar` + `AvatarFallback`, link `Button`, `StatusBadge` | avatar hidden from assistive technology, membership never shown as activity |
| `IconButton` | `Button` icon size + `ActionTooltip` on `Tooltip` | a required accessible name; busy keeps focus |
| `SendButton`/`StopButton`/`PauseButton` | `Button` default/outline/secondary + `Spinner` | stop names its target; pause is pressed state; busy keeps focus |
| `DecisionButton` | `Button` variants + `Spinner` | text-labelled decisions, a disabled reason in words |
| `MoreActions` | `DropdownMenu` + `IconButton` | one labelled overflow menu |
| `ViewHeader` | heading + `IconButton` over tokens | heading level, back/close semantics |

`ToneBadge` duplicated `StatusBadge` and is removed. `ViewHeader` is an
exception: the registries have no page-header component. `ActionTooltip`
keeps its recovery for a tooltip that must reopen after a menu closes; it is
the smallest adapter over `Tooltip`.

### 3. One semantic token layer, including portals

`src/index.css` declares the shadcn variables once — `background`,
`foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`,
`destructive`, `border`, `input`, `ring`, `radius`, `chart-1…5`, `sidebar-*`,
and the status pairs `success`, `info`, `warning` — mapped onto the Kubecode
brand primitives, on `:root` and on any element with its own `data-theme`. The
app theme sets `data-theme` and `data-kubecode-theme` on the root, so normal
pages and portalled overlays (Popover, Dialog, Sheet, Select, HoverCard,
Command, Tooltip, DropdownMenu) read the same values in both modes. The
`data-ws-components` attribute and its scoped mapping are removed.

`Badge` gains `success`, `info` and `warning` variants on those tokens.

The root font size stays 14px and official components keep their own type
scale in `rem`: a default `Button` is `text-sm` (0.875rem, 12.25px) and an
`xs` Button is `text-xs`. Product CSS no longer forces `font-size: inherit` on
Buttons, so Button text is a step smaller than surrounding 14px body text.
That is the intended scale, not a regression; a slice that needs another size
picks a Button `size` or a text utility on the call site.

### 4. CSS ownership is enforced

`scripts/check-css-ownership.mjs` runs with `pnpm lint` over every `.css` file
under `src/` (`kubecode.css`, `index.css` and any new one). Product CSS may
not select `[data-slot=…]`, `[cmdk-…]` or `[data-radix-…]` internals or use
`!important`. Rules that predate this ADR are listed in
`scripts/css-ownership-baseline.json` with the slice that removes them; the
list only shrinks, and a stale entry fails too. An entry is matched by file,
enclosing selector and line text, so a listed declaration moved under another
selector counts as new. Comments are removed before the check. The
app-level rules in `index.css` (overlay zoom compensation on the popper
wrapper and `user-select: none` on controls) are listed exceptions too. Two kinds stay as
exceptions: the xterm viewport (specialist engine) and the
`prefers-reduced-motion` block (accessibility).

### 5. One icon library and recorded sources

`components.json` sets `iconLibrary: "lucide"`, the library the registry
items use; `@phosphor-icons/react` is removed. Registries are recorded in
`components.json`: `@shadcn` (`https://ui.shadcn.com/r/styles/{style}/{name}.json`,
style `new-york`, base `radix`) and `@ai-elements`
(`https://ai-sdk.dev/elements/api/registry/{name}.json`). At this decision the
CLI is `shadcn@4.22.1`, with `radix-ui@1.4.3` and `lucide-react@1.33.0`.
Components are added with `pnpm dlx shadcn@latest add <name>` (or
`@ai-elements/<name>`), reviewed, and their icons kept on lucide.

### 6. The control matrix uses production components

`#/controls` renders the production wrappers and the production
`ConversationComposer`, never a demo-only duplicate.

### 7. Shared contract for B–I

`docs/design/ui-shared-contract.md` lists the shared components, props,
tokens, variants, CSS ownership boundaries, the portal rule, the icon rule and
how to add components. `docs/design/ui-migration-inventory.md` lists every
production surface with its owner and status.

## Consequences

- Shared controls change appearance to the official defaults: status badges
  are the official Badge (danger is the solid destructive variant), reference
  chips are outline badges, avatars the official Avatar, send is a primary
  icon button, pause an outline/secondary toggle.
- Borders, muted and accent surfaces use the hairline and soft-accent mixes
  everywhere, not only inside formerly marked surfaces.
- Slices B to H remove their own listed CSS rules and handcrafted structure;
  the baseline and the inventory track what remains.
- Adding a new rule that reaches into an official component fails lint.
