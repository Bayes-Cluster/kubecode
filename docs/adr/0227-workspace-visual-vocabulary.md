---
type: ADR
id: "0227"
title: "One visual vocabulary for Workspace views: semantic icons, layout tokens, identity, references, and scoped controls"
status: accepted
date: 2026-10-19
---

## Context

ADR 0209 made Lucide the source of command and navigation glyphs and gave icons
a size ladder; ADR 0222 introduced four shared Workspace controls (icon button,
status badge, send/stop, composer). The Research Workspace redesign (#214) still
found the same action drawn differently from view to view: a reply was a bare
arrow in one place and "Reply in thread" text in another, a member was "Agent"
in a message, an `@handle` in the navigation and a provider glyph in the roster,
an object reference was a kind and eight characters of an id, and every view
drew its own header with a "Back to Sessions" link. Spacing, reading width, and
touch targets were set per view, and nothing distinguished stopping a run from
pausing the handing-out of work.

## Decision

### 1. Semantic icon families

`src/kubecode/icons/workspaceIcons.ts` maps meanings to Lucide glyphs and to
the locale key that names them, in three families:

- **Destinations**: General, Kanban, Resources, Needs you, Members, a direct
  message, history.
- **Commands**: send, stop a run, pause and resume new work, reply, mention,
  add context, attach a file, inspect, close, back, more actions, share, retry,
  edit, remove, search, filter, copy a link, open elsewhere, new direct
  message, expand, collapse, settings, add.
- **Objects**: a Task, evidence, a file, a finding, an experiment, an artifact,
  an imported discussion, a member, a message, a Thread, a Session, internal
  work.

A glyph names one meaning: it is unique within its family, and no command
borrows a destination's or object's glyph. A view picks an entry by meaning,
never a glyph by its name; the send, stop, and pause buttons take their glyphs
from this map. Provider branding (`AiAgentIcon`), file-type icons (ADR 0209's
Material subset), and status glyphs (`statusIcons.ts`) remain separate systems.
Icon sizes stay ADR 0209's ladder (`ICON_SIZES`), including the send, stop,
and pause glyphs.

### 2. Layout tokens and interaction states

`kubecode.css` defines `--ws-*` tokens: a type scale (title, subtitle, body,
meta) that follows the researcher's UI font and size and is therefore scoped to
`.kubecode-app`, a spacing scale, a reading width for conversations and
documents, the focus ring, and the touch target. The primitives use them, and
each feature slice moves its views onto them as it changes those views.

- **Touch**: on coarse pointers every shared control is at least 44 by 44
  pixels; inline text controls (a member's name) are exempt, as in WCAG 2.5.8.
- **Focus**: a 2-pixel ring from `--state-focus-ring`, drawn as a box shadow
  over a transparent outline so it survives forced-colors modes.
- **Disabled**: a decision that cannot be made says why (`DecisionButton`'s
  `disabledReason`, linked as its description); an icon button is disabled
  only when its action does not apply.
- **Busy**: a busy control keeps focus, sets `aria-busy`, ignores clicks, and
  shows a spinner, instead of becoming `disabled`.
- **Text**: secondary text uses `--text-secondary`, and text in the danger
  color uses `--ws-danger-text`, so both meet 4.5:1 contrast; the bright error
  red stays for icons and borders. Long titles and states wrap rather than
  hiding behind a hover-only tooltip.

Colors stay the existing semantic tokens, so both themes follow.

### 3. Primitives

`src/components/workspace/` gains:

- **`MemberAvatar` and `MemberIdentity`**: one presentation of who someone is —
  an initials avatar toned by role (project manager, specialist, researcher,
  Kubecode), the name, `@handle`, and the role in words. Membership state is
  shown only when it needs attention ("Needs setup", "Removed"), never as a
  green "Active" that reads like online or running. What a member is doing
  (`activity`) is a separate slot that callers fill only from runtime facts; a
  `meta` slot carries details such as a message's time; `onOpen` makes the name
  the control that opens the profile.
- **`ReferenceChip`**: one named reference to an object — its kind glyph and,
  for assistive technology, its kind in words, its title, an optional version,
  and in words whether it `changed` since it was cited, was `removed`, or is
  `unavailable` here (private, no access, failed to load). Its accessible name
  is its visible text. It opens the object, can be removed from a draft (the
  caller then moves focus on), and never starts or authorizes anything.
- **`ViewHeader`**: a page's, view's, or detail's title (levels 1–3), optional
  icon, description, a `meta` row for status badges, and actions. A detail
  beside its list has a Close; a Back appears only on a detail screen that
  replaced its list or another detail.
- **`MoreActions`**: one labelled menu for a row's secondary actions, so rows
  show their primary action and nothing else by default.
- **`DecisionButton`**: a research decision — adding to the board, accepting
  results, sending work back, accepting an evidence version. It is always
  text-labelled, wraps long translations, has primary, secondary, and
  destructive variants, a busy state, and a `disabledReason`. An icon alone
  never authorizes, finishes, or widens work.
- **`StopButton` and `PauseButton`**: `StopButton` stops one named run now and,
  on touch screens, says what it stops in a short text; it sits before the
  send button and the composer's other controls, in the Workspace composer and
  the session composer alike. `PauseButton` pauses or resumes the handing out
  of new work in a scope the caller names — today a Task's round execution
  policy, one work item, or an execution's experiment launches ("Pause
  launches") — and lets running work finish. There is no Workspace-wide pause,
  and pausing a Team is not a `PauseButton`: it cancels the Team's running runs. Its name states the action and scope and does not change
  with the state; `aria-pressed` carries whether it is paused. Neither replaces
  sending.

### 4. A control matrix

`ControlMatrix` renders every primitive in its states (default, disabled, busy,
attention, versions, in a draft, and with the longest shipped translation of
its labels in a narrow column, marked with that language) at `#/controls[?theme=light|dark][&lang=…]`,
inside the app's style scope but outside the Workspace shell. The browser smoke
test opens it in both themes and in German on a phone and checks accessible
names, that every shared control shows the Workspace focus ring when focused by
keyboard, 44-pixel touch targets, a text label on the stop control, no sideways
scrolling, that nothing in the long samples is clipped, and that a decision too
long for its width wraps.

### 5. Adoption

The Workspace navigation's destinations adopt the vocabulary here. General,
direct messages, the Task board and review, resources, and attention adopt it
in their own slices (#216–#220) when they change those views, without changing
what an action does. Those slices have landed (#216–#220), and every one of
those views now uses this vocabulary.

## Consequences

The same action looks, sounds, and behaves the same in every Workspace view, in
both themes and on touch screens. Icon buttons, send, and stop grow to 44
pixels on touch screens everywhere, including existing session views; stop
becomes an outlined control before send in both composers. A view no longer
chooses glyphs, sizes, or spacing by hand.
