---
type: ADR
id: "0242"
title: "General and DMs on the official components"
status: accepted
date: 2026-10-21
supersedes: "0241 §4 (streamdown copy controls off) and §7 (adaptations kept behind the barrel); 0222's Composer as the conversation text box; 0233's Add context and Mention as separate icon buttons"
---

## Context

ADR 0241 installed the official shadcn/ui components and AI Elements and left
every product surface on the ADR 0233 adaptations. Slice S1 of #229 moves
General and DMs. The layout of ADRs 0239 and 0240 stays: the thread takes the
middle three quarters of the pane, the dock is `clamp(480px, 50%, 960px)`
and centred, the researcher's messages sit on the right and members' on the
left, a member's body reads at most 90 characters wide, and the last message
never sits under the dock.

## Decision

1. **Scroller.** The message log is the official `Conversation`
   (use-stick-to-bottom) with `ConversationScrollButton` ("Jump to latest").
   It replaces the hand-written "New messages below" button. Loading earlier
   messages and landing on a linked message call `stopScroll()` first, so the
   conversation does not pull the reader back to the end; the browser's scroll
   anchoring keeps the view in place when earlier messages are added. The
   reading position (ADR 0228 §4) is measured on the Conversation's own
   scroller.
2. **Messages.** Each message is an `article` around the official `Message`
   (`from="user"` for the researcher, `assistant` for members),
   `MessageContent`, and `MessageActions`/`MessageAction` for Reply. The body
   is `MessageResponse` with the ADR 0241 hardening. Two Kubecode component
   overrides apply: images render as their description, so nothing is fetched
   from a URL an agent wrote, and bold text stays a `strong` element.
   streamdown's copy controls for tables and code come back, labelled through
   its `translations` from the locale catalogs. Download and full-screen
   controls stay off.
3. **Identity.** Authors and recipients use the official `Avatar`, toned by
   role, and a `HoverCard` that repeats name, handle and role. Date
   separators use `Separator`. Delivery, intent and proposal states use
   `Badge`. An empty conversation uses `Empty`.
4. **Composer.** General and DMs share one composer on the full official
   Prompt Input: `PromptInputTextarea`, `PromptInputTools`,
   `PromptInputButton` and `PromptInputSubmit`.
   - The form never submits by itself, because that would reset the text box
     under a controlled draft. Enter and the send button go through the
     composer.
   - The keyboard and IME contract of ADR 0222 is kept:
     - Enter sends and Shift+Enter breaks the line;
     - nothing is sent while an input method composes, including Safari's
       late Enter (keyCode 229);
     - on a touch keyboard, Enter inserts the line break.
   - **Add context** becomes a `PromptInputActionMenu` with two items: Attach
     from this Workspace…, which opens the existing dialog, and Mention
     someone.
   - The `@mention` picker is `PromptInputCommand` (cmdk) with filtering off.
     Focus stays in the text box. The arrows move the highlight, and Enter
     chooses. Tab chooses only once there is something to complete. Escape
     closes the picker. The text box's `aria-controls` and
     `aria-activedescendant` point at cmdk's list and option.
   - The old `Composer` stays in `components/workspace/` for the control
     matrix until S5.
5. **Outbox.** Each unsent message is the researcher's `Message`, either
   pending or failed. A failed one has Send again, Edit and Discard as
   `MessageAction`s.
6. **Running list.** In the pill `Popover`, the running work is a `Queue`
   with one `QueueSection`. Each row is a `QueueItem` holding an `Item`:
   - the first line has the member and the queued count;
   - the second line has the Task or "Replying";
   - `ItemActions` has the one Stop.

   The Stop semantics of ADR 0238 are unchanged, and so is the two-line row of
   ADR 0240.
7. **Requests.** Permission and input requests are the official
   `Confirmation`. It stays a named, focusable group rather than an alert.
   Its answers are `ConfirmationAction`s that keep focus while busy. Input
   fields use `Field`. The keyboard contract is unchanged:
   - 1–9 choose a permission option;
   - every option is a button;
   - the request is focusable from Needs you.
8. **Filter and references.** General's Task filter is the shadcn `Select`.
   References are the official `Sources`. Its `SourcesProps` gets a
   type-only Kubecode edit so `defaultOpen` type-checks. A source is a
   reference chip that opens in the Workspace, not a link.
9. **Cleanup.** The ADR 0233 adaptations in `ai-elements/workspace/`, the
   `@/components/ai-elements` barrel, their tests, and their `kubecode-ai-*`
   CSS are deleted. The surfaces opt into the token mapping with
   `data-ws-components="official"`.

## Consequences

- General and DMs follow the official components and their upgrades.
- Removing `kubecode.channel.newMessages` and other locale keys this slice
  leaves unused is part of S5.
- `Shimmer` (motion) animates without a reduced-motion switch, as in the
  official file.
- `InlineCitation` stays deferred (ADR 0236).
