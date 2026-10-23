---
type: ADR
id: "0248"
title: "The Workspace shell on the official Sidebar, Sheet and Resizable"
status: accepted
date: 2026-10-23
---

## Context

Issue #256 (UI B, under #254) moves the shell the other slices sit in onto
official components: the navigation, the title bar, the phone overlays, the
resize handles, the inspector container and the command palette. ADR 0247 set
the rule that official components own structure and behaviour; this ADR
records how the shell applies it and the one new dependency it needs.

Before this change the shell drew its own versions of these:

- the navigator was a `nav` with handcrafted rows, a native `details` for
  execution history and an input with a positioned icon;
- on a phone the navigator and the Files and Git panel were absolutely
  positioned overlays behind a raw scrim `button`, with a document `keydown`
  listener for Escape and no focus trap;
- three `ResizeHandle` divs resized the navigator, the context panel and the
  terminal with mouse events only (no keyboard, no touch);
- the title bar used `/` spans for its location, `aria-pressed` Buttons for
  the layout toggles and loose `div` rows inside the connection menu;
- the command palette kept its own listbox, active-descendant state and arrow
  key handling inside a Dialog.

## Decision

### 1. One navigation: Sidebar, and a Sheet on a phone

The navigator is the official `Sidebar` (`collapsible="none"`) with
`SidebarHeader`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`,
`SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuAction`
and `SidebarMenuBadge`. Workspace rows, the five places, the roster and the
private conversations are menu items; the current one is `isActive` and keeps
`aria-current`. Execution history is a `Collapsible` whose trigger is the group
label; while it holds what is on screen or a search, closing it is ignored.
The Session search is an `InputGroup` with a `Kbd` hint.

`SidebarProvider` wraps the workspace and owns the navigation's open state as a
controlled prop (`open`/`onOpenChange` are the shell's existing state), so the
official Cmd/Ctrl+B shortcut toggles the same navigation as the title-bar
toggle. There is still one open state and one location model.

The phone layout keeps its own 980-pixel breakpoint, so the navigator and the
Files and Git panel open in official `Sheet`s (left and right) rather than in
the Sidebar's built-in mobile mode, whose breakpoint is 768 pixels. The Sheet
owns the overlay, focus trapping, Escape and focus return; the scrim button
and the Escape listener are removed. Because a Sheet is modal, a phone opens
on the place with both Sheets closed, and they open only on demand; entering
the narrow layout closes them. The Sheets' state is not a preference: the
remembered wide-screen choices (navigation and Files and Git open or closed)
are kept and come back when the layout widens. When the navigation Sheet opens, focus
goes to the current place (else the current Workspace, else the Sheet), not to
the first header action, whose tooltip would take the first Escape.

### 2. Resizable panels, with `react-resizable-panels`

The shell layout is the official `Resizable` (`ResizablePanelGroup`,
`ResizablePanel`, `ResizableHandle`): navigation | main, and inside main the
place | Files and Git row over the terminal. The registry item depends on
`react-resizable-panels`; it is added at `4.14.8` (`^4`), MIT licensed, no
transitive runtime dependencies, through the official CLI.

- Sizes stay in pixels, as before: each panel's `onResize` writes the measured
  size into the existing layout state (persisted per Workspace and for the
  navigator), and `groupResizeBehavior="preserve-pixel-size"` keeps a panel's
  width when the window changes. A panel reads its default size once, when it
  mounts; a later change (another Workspace's remembered layout) is applied
  through the panel's imperative ref.
- The terminal panel is `collapsible`: its toggle collapses and expands it,
  and dragging it shut closes the terminal like its toggle.
- Separators are keyboard operable (arrow keys, Home/End) and touch friendly,
  and each is named ("Resize navigation", "Resize context panel", "Resize
  terminal").

`ResizeHandle` stays only for the terminal split inside `TerminalWorkspace`,
which #262 moves onto this decision.

### 3. Title bar, palette and shell states

- The location is a `Breadcrumb` (`BreadcrumbPage` marks the place with
  `aria-current="page"`), named "Location".
- The layout toggles are `Toggle`s (pressed state from Radix).
- A global error is a destructive `Badge` with a `Tooltip`.
- The connection menu shows its status rows as `DropdownMenuLabel`s in a
  `DropdownMenuGroup`, with the state as a `Badge`.
- The command palette is `Command` inside the shell's `Dialog`: cmdk owns the
  listbox, selection and arrow keys; the shared ranking still filters, so cmdk
  filtering is off (`shouldFilter={false}`); provenance chips are outline
  `Badge`s; loading is a `Spinner`, a failure an `Alert`, no match
  `CommandEmpty`. `CommandDialog` is not used because it does not pass
  `onCloseAutoFocus`, which the palette needs to return focus.
- The notification onboarding is an `Alert` with its two actions; route
  opening is an `Empty` with a `Spinner`.

### 4. Local trims to vendored files

The CLI output is kept except where it breaks a lint rule that is not
silenced: `toggle.tsx` exports only `Toggle` (not `toggleVariants`), and
`sidebar.tsx` drops `SidebarMenuSkeleton` (it calls `Math.random` during
render) and the `useSidebar` export. Nothing in Kubecode uses them; a slice
that needs them adds them back with a lint-clean implementation.

### 5. Test environment adapters

jsdom has no `matchMedia` and lays nothing out. The shared test setup gives a
non-matching `matchMedia` (the Sidebar's `useIsMobile` needs one), and reports
the resizable group, panel and separator elements off-screen, because the
library otherwise takes every pointerdown at (0, 0) for a separator drag and
prevents it. Real sizes are checked in the browser smoke run.

### 6. Page and inspector containers for slices C to H

- **Page.** A destination renders inside the Resizable "place" panel, whose
  inner element is a flex row with `overflow: hidden`. The page root is a flex
  child that fills it (`flex-1 min-w-0 min-h-0`), owns its own scrolling, and
  is titled by `DestinationHeader` (level 2). A page never sizes itself from
  the viewport and never renders the navigation, the title bar or a resize
  handle.
- **Inspector.** A view that hosts the inspector wraps its content in
  `WithInspector` and receives the shell's `InspectorPane`. Each entry renders
  exactly one `InspectorPanel`: one `ViewHeader` (level 3) with the Back and
  Close the pane computes, and `status` `ready`, `loading` (an official
  `Spinner` status) or `unavailable` (an official `Empty` status with an
  optional recovery). A panel never renders its own aside, Back or Close, and
  moves through `useInspectorEntry` (`push`, `replace`, `back`, `close`).
- **The inspector stack stays an adapter.** No registry component is a
  non-modal inspector in the page flow that keeps lower entries mounted and
  parked: `Sheet` is modal and portalled, a right-hand `Sidebar` has one level
  and `Resizable` has no stack. `DetailPane` keeps the smallest adapter: focus
  on open, focus back to the opener (or its `data-focus-key` successor) on
  close, and Escape pops one level unless an input, a combobox or a listbox
  holds it. `DetailPane.test.tsx` and `InspectorPane.test.tsx` cover it.

## Consequences

- Cmd/Ctrl+B toggles the navigation anywhere in the page, including over the
  terminal and editors. That is the official Sidebar behaviour; a terminal
  user who relies on Ctrl+B (for example a tmux prefix) loses it while the
  page has focus. A future ADR may ask the registry for an opt-out.
- `components.json` lists `@shadcn` among its `registries`; the CLI at
  `shadcn@4.22.1` rejects that reserved name ("Invalid configuration"). The
  components here were added with that key removed for the run; slice A owns
  the file.
- On a phone the navigation Sheet is modal: the view under it is not
  interactive until the Sheet is dismissed (overlay, Escape or close button).
- Other slices render inside the Resizable "place" panel; their containers
  should be flex children that fill it (`flex-1 min-w-0 min-h-0`).
