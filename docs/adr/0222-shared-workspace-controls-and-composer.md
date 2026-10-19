---
type: ADR
id: "0222"
title: "Shared Workspace controls and one Composer for General and direct messages"
status: proposed
date: 2026-10-19
---

## Context

The Workspace views grew one at a time. An icon-only action was a bare `Button`
with an icon in one place and a hand-styled `<button>` in another; a status was
a `<span>` with an ad hoc class; the session composer drew its own round send
and stop buttons with inline styles while the conversation composer had a text
"Send" button and sent on Ctrl+Enter. Keyboard and IME behavior were
implemented separately, so a Japanese input method confirming a candidate with
Enter could send a half-written message in one surface and not another. The
Research Workspace (#199) puts General and every direct message (DM) on one
interaction vocabulary, and the same agent may serve both, so the controls must
behave identically.

## Inventory

For the surfaces this change touches (`kubecode/channel`, `work`, `members`,
the session composer chrome): 36 hand-written status badges (`<span
class="kubecode-research-badge" data-tone=…>`) across 12 files, eight
icon-only controls using three different sizes and no tooltip, two send
buttons (one round with an arrow and inline styles, one a text button), and two
different send shortcuts. Everything else in those views already uses shadcn
`Button`, `Dialog`, `Textarea`, Lucide icons, and semantic tokens. A
repository-wide rewrite is out of scope; the scope is the Workspace views and
the composers.

## Decision

### 1. Four primitives, one folder

`src/components/workspace/` holds the shared vocabulary of Workspace views:

- **`IconButton`** — the one icon-only control. The label is required and is
  both the accessible name and the tooltip (an icon alone is never a name); it
  has a compact and a regular size, visible focus from the shadcn button, a
  touch-sized hit area on coarse pointers, and a `busy` state that disables it
  and sets `aria-busy`.
- **`StatusBadge`** — one status label with a tone (`ok`, `info`, `warn`,
  `danger`, `muted`) taken from the semantic feedback tokens. The text always
  carries the meaning; the tone only adds emphasis, so color is never the only
  signal.
- **`SendButton` and `StopButton`** — the round arrow send button and the stop
  button. Both are Lucide icons with tooltips. The stop button's label always
  names what it stops ("Stop Analyst"), and it is a separate control from send.
- **`Composer`** — the composition surface: text, `@mentions`, a slot for
  caller controls (attach, intent), the send button, an optional named stop,
  and slots for references above and hints below.

### 2. One keyboard and IME contract

Enter sends; Shift+Enter breaks the line; nothing is sent while an input
method is composing (`compositionstart`/`compositionend`, `isComposing`, and
the legacy 229 key code). `@` after whitespace opens a member list that is an
ARIA combobox with a listbox: the arrow keys move, Enter or Tab inserts
`@handle `, Escape closes, a click inserts without leaving the text box.
Typing on reopens the list. Mention parsing is a set of pure functions.

### 3. Sending is independent of stopping

Sending stays available while agents are working: the only thing that disables
it is an empty draft, a disabled composer, or a send of this very draft that
is still in flight (so one draft is not sent twice). Stopping a task or agent
is a different control that names its target and never replaces the send
button.

### 4. What stays out of the primitive

The `Composer` does not know about channels, Tasks, members, or stores. A
caller supplies the `MentionOption`s (id, handle, label), reads which ones the
text mentions (`extractMentions`), and decides what a mention or a message
*means*; domain routing stays in the messaging layer. The conversation
composer (`MessageComposer`) is the first user: General and DM both use it.
The session composer keeps its provider-specific machinery (ACP commands,
agent configuration, capability menus) and shares the send and stop buttons,
not the text surface.

### 5. Localization and accessibility

All labels are passed in by the caller from the locale catalogs, so a
primitive has no copy of its own. Controls are keyboard-operable, the mention
list uses the combobox pattern, busy and disabled states are exposed with
`aria-busy` and `disabled`, and the touch hit area grows on coarse pointers.

## Consequences

Workspace views look and speak alike, and a keyboard or IME fix is made once.
The conversation composer now sends on Enter, as the session composer already
did; Ctrl/Cmd+Enter no longer has a special meaning. The session composer's
round send and stop buttons are now these components (their test ids are
kept). Remaining hand-written controls outside the touched surfaces keep
their current form until a view is next changed.
