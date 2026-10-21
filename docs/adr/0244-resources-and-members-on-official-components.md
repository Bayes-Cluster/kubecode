---
type: ADR
id: "0244"
title: "Resources and Members on official shadcn/ui and AI Elements components"
status: accepted
date: 2026-10-21
---

## Context

ADR 0241 installed the official shadcn/ui components and AI Elements and
moves the Workspace onto them one slice at a time. Slice S3 covers Resources
and Members: the record preview, the Resources result list, the member
roster, the defaults for new members, the member profile, and the manager
setup notice. They were hand-rolled: a `<pre>` for every record, native
`<select>` and `<input>` controls styled as `kubecode-channel-select`, a
`<dl>` of member facts, and a custom warning box. The product owner chose to
build these surfaces from the official parts. The ADR 0239/0240 layout rules,
the record reader contract (ADR 0231 §4) and the keyboard and focus contracts
stay as they are.

## Decision

1. **Record preview.** `RecordPreview` shows each section by the record's
   format:
   - a code or text file renders in the AI Elements **Code Block**. The file
     extension picks one Shiki language from a short allow-list, and the Code
     Block's highlighter cache loads only that language. An unknown extension
     renders as plain `text`, so no language is guessed. CSV stays plain
     text. The block is one keyboard-focusable scroll region;
   - a Markdown file (`.md`, `.markdown`, `.mdx`) and every written record
     (Task brief, finding, thread, Session) render through **streamdown** in
     static mode, with `HARDENED_STREAMDOWN_PROPS` from
     `streamdown-hardening.ts`: no raw HTML, http/https/mailto links only, and
     KaTeX math.
2. **Resource list.** Each result row in `WorkspaceSearch` (used by Resources,
   Add context and the titlebar search) is an **Item** (`ItemMedia`,
   `ItemContent`, `ItemTitle`, `ItemDescription`) rendered as the existing
   `role="option"` list item. The listbox, the active descendant and the
   focus return all work as before.
3. **Members.**
   - Roster rows are **Items** (`ItemContent`, `ItemActions`) on the existing
     list items. The avatar remains the shared `MemberIdentity` avatar, which
     slice S1 moves to the official Avatar for every identity at once.
   - Form fields are **Field** / `FieldLabel` / `FieldDescription` /
     `FieldSet` / `FieldLegend`, with **Input**.
   - Role and provider choices are shadcn **Select** (Radix), through one
     `ProviderSelect` used by the roster and the defaults panel. These replace
     the native `kubecode-channel-select`. An unavailable provider is listed
     but disabled, unless it is the one already saved.
   - Profile facts are horizontal **Field**s in a `FieldGroup`.
4. **Setup notice.** `ManagerSetupNotice` is an **Alert** (`AlertTitle`,
   `AlertDescription`) in the warning tone, and keeps `role="alert"`.
5. **Theming.** Every surface in this slice sets
   `data-ws-components="official"` (ADR 0241 §5). The Resources and Members
   rules sit in one delimited block at the end of `kubecode.css`.
6. **No new dependencies and no new copy.** Everything used was installed in
   S0. All labels come from existing locale keys.

## Unpublished or deferred

- **Command for search.** `WorkspaceSearch` keeps its own combobox. cmdk
  filters and ranks items on the client and owns the active item. Resources
  search is server-side and paged. It has a reported scope, IME-safe keys,
  Home/End, attach-on-ArrowRight and focus memory (ADR 0228 §4), and these
  would have to be rebuilt around cmdk. Revisit this when `Command` can run
  unfiltered with a controlled active value, or in S5.
- **Inspector chrome of `ResourcePanel`.** It is unchanged in this slice: its
  badges are the shared `StatusBadge` and its frame is `InspectorPanel`, both
  shared with other slices. Its preview body is the new `RecordPreview`.
- **Select menus inside the official theme.** Select menus are portalled
  outside the opted-in subtree, so they use the global shadcn aliases until S5
  makes the official mapping global.
- **Code Block controls.** Copy and language selector are not shown: their
  published labels are English, and the preview is read-only.

## Consequences

- Records read as formatted Markdown or highlighted code. The highlighter
  loads only the language a file needs, on first view.
- Tests address role and provider through the Select's combobox and options.
  Native `change` events no longer apply.
- S5 removes the now-unused `kubecode-channel-select` rules for member forms,
  `kubecode-detail-facts` for members, and `.kubecode-work-evidence-text`
  once no surface uses them.
