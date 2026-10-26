---
type: ADR
id: "0257"
title: "The agent-ui presentation layer recreates the affectUI references"
status: accepted
date: 2026-10-26
supersedes: "0247 §1 and 0256 §1 where they make an official component the only permitted presentation owner; 0241 §1 for presentation components outside `src/components/ui` and `src/components/ai-elements` (the CLI path stays in force inside them). ADR 0255 and the hardening, localisation, privacy and removal contracts are preserved whole."
---

## Context

Issue #276 was rewritten: instead of asking official shadcn/AI Elements to own
all appearance, Kubecode recreates the relevant affectUI components, screens
and blocks with its own React parts on the existing stack. The original #277
shipped in #291 (ADR 0256) and stays. The reopened #277 — this ADR — is the
foundation slice: the presentation contract every later slice builds on.

The public affectUI catalog was captured on 2026-10-26: 124 entries (66
components, 15 screens, 11 blocks, 8 motion effects, 24 illustrations), each
with a disposition (`Recreate` / `Adapt` / `Defer` / `No fit`) and an owning
slice in [the inventory](../design/affectui-inventory.md). The current public
**Clean** previews are the initial visual baseline; App Shell Workspace Flat is
the primary overall frame. 211 production TSX files at `378b035` each have one
owning slice.

Today the product has two stylesheets (`src/index.css`,
`src/kubecode/kubecode.css`), the CSS ownership checker of ADRs 0247/0256, no
FLIP utility, and one motion dependency (`motion`, used by `ai-elements/
shimmer.tsx`). Reduced-motion handling exists in `src/lib/reducedMotion.ts`.
The existing `Toaster` is Sonner under the semantics fixed by ADR 0256 §3.

## Decision

### 1. One presentation owner: an official part or an agent-ui part

Every shared visual component has exactly one presentation owner. The owner is
either an official shadcn/ui or AI Elements file (which owns its structure and
its variants, ADR 0256) or a component of the owned presentation layer
`src/components/agent-ui/` (§2). Call-site repainting stays a defect in both
cases: a `className` that changes the size, padding, border, radius, font or
colour of a part someone else owns is not allowed, at any call site, for any
owner.

This narrows two clauses of the earlier programme:

- ADR 0247 §1 ("official components own base appearance") and ADR 0256 §1
  ("an official shadcn/ui or AI Elements component renders the structure and
  its variants render the appearance") made the official component the only
  permitted owner. They stay in force for everything already governed by them
  (the official files, their variants, the survivors of 0256 §5); an agent-ui
  component is now the second permitted owner for the shared visual patterns
  this programme recreates.
- ADR 0241 §1 ("Components come from the shadcn CLI only") stays in force for
  `src/components/ui` and `src/components/ai-elements`, including the
  `Kubecode (ADR …)` comment rule for reviewed edits. Components in
  `src/components/agent-ui/` are instead written in this repository from the
  public references, per §3. No affectUI package, runtime or Pro source is
  installed, ever.

Everything else in those ADRs is unchanged: the variant tables, the Sonner
host semantics (0256 §3), the registry and catalogue rules (0256 §4), the
retired-wrapper list (0256 §5), and the single Markdown renderer with its
hardening (0255) are preserved whole. Feature slices adopt agent-ui parts by
replacing their own scattered presentation, not by restyling the official
primitives those parts compose.

### 2. The `src/components/agent-ui/` layer

The proposed folder name is final: `src/components/agent-ui/`.

- One component per kebab-case file, with its styles co-located as
  `<name>.css` imported by the component, and its tests co-located as
  `<name>.test.tsx`. The barrel `index.ts` is the only import surface for
  consumers; nothing outside the directory imports a deep path.
- Class prefix `agx-`, custom properties `--agx-*`. The prefix keeps the
  checker's dead-style accounting (§6) exact.
- Pure presentation: strings, state and callbacks in, DOM out. An agent-ui
  component never fetches, never reads a domain store, never imports
  `WorkspaceService` or the locale catalogs. Every visible or accessible
  string arrives through props from the call site, which passes localized copy
  (ADR 0241 §6's rule, applied one layer out). Required labels have no English
  default.
- An agent-ui component may compose `ui/` and `ai-elements/` primitives and
  engines. It obeys the same rule as product code towards them: choose a
  variant or size, pass layout classes, never repaint their internals (ADR
  0256 §1).
- Feature modules consume agent-ui parts through the barrel. They may not
  style `agx-*` internals (enforced, §6) and may not re-implement a pattern
  the layer already owns: one implementation per shared visual component.

### 3. Reference discipline

Every implemented agent-ui component carries a documentation block at the top
of its file recording:

- the reference URL(s) (component page and demo module),
- the style variant captured (the public **Clean** preview unless stated),
- the capture date (2026-10-26 for this programme's planning evidence),
- the exact parts reproduced and the parts deliberately deviated,
- the state mapping (which Kubecode/props states render which visual states),
- where its states are demonstrated (`#/controls`, §7).

The mechanism (state flow, DOM, animation) is studied from the public demo
modules and re-implemented; demo code, its timers and its placeholder data are
not copied into production. The whole-catalog disposition and the per-file
integration ledger live in `docs/design/affectui-inventory.md`, committed with
this ADR; each merged slice updates the implementation-state rows it owns. A
reference link is not an instruction to copy its domain features.

### 4. Visual grammar: the Clean baseline mapped to semantic tokens

The Clean previews' measurements, and how agent-ui maps them onto Kubecode's
tokens (root font 14 px; no brand value is hardcoded in agent-ui CSS):

| Clean reference measurement | agent-ui rule |
| --- | --- |
| Ink `rgba(0,0,0,.88)` / muted text `.61` / icon `.45` | `--agx-ink: var(--text-primary)`, `--agx-text: var(--text-secondary)`, `--agx-faint: var(--text-tertiary)` |
| Hairline `.5px` ring + layered float shadow | `--agx-line: var(--border-subtle)`, `--agx-line-strong: var(--border-default)`, shadow stacks on the same recipe over `var(--shadow-dialog)` for elevation |
| Surface `#fff` / track `rgba(0,0,0,.04)` / wash `.03` | `--agx-surface: var(--surface-card)`, `--agx-track: var(--state-hover)`, `--agx-wash: var(--state-hover-subtle)` |
| Solid fill (primary) | `--agx-solid: var(--accent-blue)`, `--agx-on-solid: var(--text-inverse)` |
| Danger / success / info accents | `--feedback-error-*`, `--feedback-success-*`, `--feedback-info-*` |
| Focus outline `2px`, blue | `2px solid var(--state-focus-ring)`, offset 1–2 px, never removed |
| Radius 6 px controls / 8–10 px cards, toasts | official radius scale (`--radius`-based rounded utilities); toasts and cards `--radius`-derived large |
| Control heights 24/28/32 px (sm/md/lg) at 16 px root | heights come from the official scale the component replaces or composes (h-7/h-8/h-9 band at the 14 px root); the reference's proportions (px-to-height, icon-to-height) are kept |
| Text 12/13 px, weight 500 on controls | `text-xs`/`text-sm` rem sizes at the 14 px root; `font-variant-numeric: tabular-nums` on all counters |
| Coarse-pointer heights ≥40 px (44 px tray) | the ADR 0256 convention unchanged: nothing interactive below a 44 px target on a coarse pointer |
| Motion: `cubic-bezier(.22,1,.36,1)` (geometry/enter), `cubic-bezier(.25,1,.5,1)` (width morphs); 120–160 ms hover, 200–260 ms indicator, 320–480 ms surface | tokens `--agx-ease`, `--agx-ease-morph`, `--agx-dur-fast/base/slow`; reduced motion settles every component in its final state immediately (CSS `@media` plus `usePrefersReducedMotion` for JS loops) |

### 5. Motion and FLIP contract

- Motion is part of the design, bounded, and always state-driven: every
  animation starts from an authoritative state change (a real event, a
  confirmed value), never from a timer invented in the component. Demos keep
  their timers; production passes `phase`/`value` from the domain.
- Preferred tools, in order: CSS transitions/animations for opacity,
  transform, clip, filter and background-position; WAAPI
  (`element.animate`) for measured geometry, because the browser cancels and
  retargets it; the `motion` package only where an existing consumer already
  uses it. No new animation dependency.
- FLIP (`agent-ui/flip.ts`): read first geometry before a known commit,
  re-measure after commit in `useLayoutEffect` (never during render), invert
  with a transform, animate to identity; interrupted runs cancel/retarget;
  unmount cancels and clears; reduced motion applies the final state
  immediately. Lists opt in per item with stable keys; a streamed token must
  never trigger measuring or animating a whole list (callers gate by item
  set changes, not by every update).
- Status announcements are event-based: a `role="status"`/`aria-live="polite"`
  region's text changes only when the underlying state changes. Elapsed-time
  labels freeze at the authoritative end value instead of ticking into the
  region.
- Reduced motion is tested per component, not assumed from a global clamp.

### 6. CSS ownership extension

`scripts/check-css-ownership.mjs` learns owned presentation directories:

- `PRESENTATION_DIRECTORIES = ['src/components/agent-ui']`. A new violation
  kind, `appearance-on-agent-ui`, flags a rule in any stylesheet **outside**
  those directories whose subject class an agent-ui TSX file uses as its own
  `className`, with an appearance declaration. Co-located styles inside
  `agent-ui` are accepted for its own classes and its own subtree — reaching
  its own elements is what owning the presentation means — while staying
  subject to every rule that protects someone else's CSS
  (`official-internal`, `third-party-internal`, `important`,
  `appearance-on-official`).
- The dead-style checks (`dead-class`, `dead-rule`) cover the `agx-` prefix
  beside `kubecode-*`.
- `agent-ui/toaster.css` styles the Sonner host engine through its documented
  `[data-sonner-*]` extension points (ADR 0256 §3 keeps the host). The
  engine's own stylesheet (`sonner/dist/styles.css`) had not been imported
  anywhere, so toasts rendered unstyled since #291; the toaster presentation
  loads it and paints the Clean skin on top. Those selectors join the narrow
  third-party engine exceptions (like `.xterm`), attributed to `agent-ui`,
  listed in the baseline rule by rule; the list only shrinks.
- `docs/design/ui-shared-contract.md` §4 gains the agent-ui row so the
  contract and the checker say the same thing.

### 7. Gallery and tests

- `#/controls` gains an agent-ui section rendering the production agent-ui
  components with deterministic fixtures — idle, busy, updating, settled and
  disabled states, both themes via `?theme=`, locales via `?lang=`; the error
  state stays where it exists, on the live toast host. No second demo
  implementation is added anywhere.
- Vitest `include` and coverage `include` are extended to
  `src/components/agent-ui/**` so the layer is tested and counted by the four
  ≥70 % metrics.
- Required per component: animation interruption and unmount cleanup (no rAF,
  timer or observer leaks), stable focus across value changes, duplicate-action
  prevention while busy, reduced-motion immediate settle, and event-based
  announcements.

### 8. Performance budgets

Baseline on this branch (`vite build`): entry chunk 6,073 kB (1,632 kB
gzipped), CSS 231 kB (42 kB gzipped).

- agent-ui code is only in the entry because a production surface renders it;
  the gallery (`#/controls`) stays lazy. Each slice that adopts an agent-ui
  part records the entry/CSS delta of its PR; a growth of more than 30 kB
  gzipped entry or 15 kB CSS over the baseline requires a new ADR. This
  foundation itself (the barrel reaching the entry through the toast host,
  the Sonner base stylesheet, and the gallery section) measures +7.8 kB
  gzipped entry and +5.6 kB gzipped CSS — within budget.
- No layout reads during render; rAF loops run only while an animation is
  live; offscreen tickers are gated by IntersectionObserver; toast timers
  pause on hidden tabs (the host engine's behaviour).

## Consequences

- Slices B–L implement their richer shared components under this contract and
  consume the A-owned primitives; A does not implement every surface itself.
- Co-located component CSS appears for the first time under `src/components`;
  the checker's baseline gains the sonner-host rules and loses nothing.
- The inventory document becomes the programme's living ledger; the older
  `ui-migration-inventory.md` keeps recording the finished #254 programme.
- The reference demo modules are public documents; studying them creates no
  licensing obligation, and no affectUI code is vendored.
