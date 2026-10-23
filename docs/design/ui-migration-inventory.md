# UI migration inventory

Issue #255 (UI A) under #254. Every UI reachable from a production route, its
current implementation, the official replacement, who owns the migration, and its
status. Statuses: `migrated` (official component owns structure and appearance),
`partial` (official parts inside handcrafted structure or CSS redraw),
`handcrafted`, `specialist-engine` (no registry equivalent; evidence given),
`exception` (justified thin composition), `not-applicable`.

Owners: #255 A shared foundation, #256 B navigation/inspectors/global interactions,
#257 C General and DM conversation/composer, #258 D search/references/attachments/evidence,
#259 E Tasks/reviews/Needs you/execution feedback, #260 F members/setup/settings,
#261 G Session and Team views, #262 H file/Git/terminal/research utilities, #263 I route audit.

The contract each slice follows is in [ui-shared-contract.md](ui-shared-contract.md) and
[ADR 0247](../adr/0247-official-components-own-base-appearance.md). Earlier completion
claims under #229 are not exemptions: a row is `migrated` only when the official
component owns its structure and appearance. CSS rules that still reach into official
components are listed, with their owner, in `scripts/css-ownership-baseline.json`.

## Summary

| Status | Rows |
| --- | ---: |
| migrated | 229 |
| partial | 0 |
| handcrafted | 0 |
| specialist-engine | 4 |
| exception | 15 |
| not-applicable | 8 |

| Owner | Rows |
| --- | ---: |
| #255 | 20 |
| #255 with #257-#262 | 1 |
| #255/#263 | 1 |
| #256 | 32 |
| #256-#263 | 1 |
| #257 | 26 |
| #257/#263 | 3 |
| #258 | 18 |
| #258/#262 | 1 |
| #259 | 48 |
| #260 | 28 |
| #261 | 37 |
| #262 | 35 |
| #262/#263 | 1 |
| #263 | 4 |

#263 final audit (route by route, 1440/1024/390/320, light and dark, en-US and de-DE): no row is `partial` or `handcrafted`. What remains is `exception` (a documented thin adapter or semantic HTML around official parts), `specialist-engine` (xterm, CodeMirror, react-virtuoso, the contenteditable mention engine) or `not-applicable`. The audit findings and their resolution are in [HANDOFF.md](../HANDOFF.md).

## Shell

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WorkbenchShell layout root (main.kubecode-app / .kubecode-workspace / main stack) | `src/kubecode/app/WorkbenchShell.tsx:1054,1098,1197` | SidebarProvider (navigation open state) + ResizablePanelGroup/ResizablePanel; `.kubecode-workspace` keeps layout only | shadcn/ui Sidebar (SidebarProvider/SidebarInset) + Resizable | all workspace routes | #256 | migrated | ADR 0248 |
| Panel resize handles | `src/components/ResizeHandle.tsx:9; src/kubecode/app/ProjectNavigator.tsx:790; WorkbenchShell.tsx:7` | ResizableHandle separators (named, keyboard and touch) in WorkbenchShell; ProjectNavigator has none | shadcn/ui Resizable (ResizablePanelGroup/ResizableHandle) | navigator, main stack, terminal | #256 | migrated | ADR 0248: `react-resizable-panels@4.14.8` added via the CLI. the terminal split moved to Resizable in #262 and `ResizeHandle` was removed (ADR 0252) |

## Phone

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Navigator/context overlay 'sheet' + scrim button | `src/kubecode/app/WorkbenchShell.tsx:410,1099-1104` | Sheet side=left (navigation) and side=right (Files and Git) below 980px; scrim button and Escape listener removed | shadcn/ui Sheet (installed) or Sidebar mobile mode | narrow layout | #256 | migrated | ADR 0248: the Sidebar's own mobile mode is not used because its breakpoint (768px) differs from the shell's 980px |

## Title bar

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WorkbenchTitlebar header, project/place breadcrumb | `src/kubecode/app/WorkbenchTitlebar.tsx:110-130` | Breadcrumb / BreadcrumbList / BreadcrumbPage (aria-current), named Location | shadcn/ui Breadcrumb (not installed) | all routes | #256 | migrated | — |
| Topbar error indicator | `src/kubecode/app/WorkbenchTitlebar.tsx:140-146` | Badge destructive + Tooltip, role=status named by the error | shadcn/ui Tooltip + Badge or Alert | global errors | #256 | migrated | — |
| Notification bell (Needs you) menu: labels, entries with StatusBadge, show all, other workspaces, separator | `src/kubecode/app/WorkbenchTitlebar.tsx:149-210` | DropdownMenu + StatusBadge; entry is layout-only flex column; `.kubecode-attention-*` CSS removed | shadcn/ui DropdownMenu + Badge | Needs you entries, other workspaces | #256 | migrated | — |
| Runtime connection menu (status rows, retry) | `src/kubecode/app/WorkbenchTitlebar.tsx:239-270` | DropdownMenuLabel rows in DropdownMenuGroup with a state Badge; Retry DropdownMenuItem; `.kubecode-connection-*` CSS removed | shadcn/ui DropdownMenu + Item/Badge | event stream state | #256 | migrated | — |
| Layout toggles (navigation/terminal/context) | `src/kubecode/app/WorkbenchTitlebar.tsx:210-215,284-295` | Toggle (Radix pressed state) + Separator | shadcn/ui Toggle / ToggleGroup (not installed) | shell panels | #256 | migrated | — |

## Global command

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Global command palette (Ctrl/Cmd+Shift+P) | `src/kubecode/GlobalCommandPalette.tsx:99,299-370; WorkbenchShell.tsx:770-786` | Dialog + Command/CommandInput/CommandList/CommandGroup/CommandItem (cmdk owns listbox, selection, arrows); provenance as outline Badge | shadcn/ui CommandDialog/Command (installed) | whole app | #256 | migrated | ADR 0248: `CommandDialog` is not used because it does not pass `onCloseAutoFocus`; cmdk filtering is off because the shared ranking filters. #263: the palette opens on Ctrl/Cmd+Shift+P (`src/kubecode/commandPalette.ts`); Cmd/Ctrl+K focuses the Session search (see Keyboard) |
| Palette loading/empty/error states | `src/kubecode/GlobalCommandPalette.tsx:354-370` | Spinner status / Alert destructive / CommandEmpty | CommandEmpty / Spinner | palette | #256 | migrated | — |

## Navigator

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ProjectNavigator heading actions (add project, settings, help) | `src/kubecode/app/ProjectNavigator.tsx:105-110` | SidebarHeader + IconButton (Add project, Settings); the help button with no action is removed | shadcn/ui Button + Tooltip (IconButton) | sidebar | #256 | migrated | — |
| Workspace (project) switcher list rows + status | `src/kubecode/app/WorkspaceList.tsx:57-115` | SidebarMenu/SidebarMenuItem/SidebarMenuButton/SidebarMenuAction/SidebarMenuBadge; run state in words (role=img label) beside a dot | shadcn/ui SidebarMenu/SidebarMenuButton/SidebarMenuAction | sidebar | #256 | migrated | — |
| Project row actions hidden menu (new session, toggle workspaces, delete) | `src/kubecode/app/WorkspaceList.tsx:82-105` | DropdownMenu on a SidebarMenuAction trigger | shadcn/ui DropdownMenu | WorkspaceList | #256 | migrated | — |
| No-project empty text | `src/kubecode/app/WorkspaceList.tsx:48; WorkbenchShell.tsx:1378` | Empty | shadcn/ui Empty (installed) | sidebar, main | #256 | migrated | — |
| History section collapsible | `src/kubecode/app/ProjectNavigator.tsx:126-138` | Collapsible with SidebarGroupLabel trigger; pinned open while it holds the place or a search | shadcn/ui Collapsible (installed) / SidebarGroup | sidebar | #256 | migrated | — |
| History session search input | `src/kubecode/app/ProjectNavigator.tsx:139-150` | InputGroup + InputGroupAddon + Kbd | shadcn/ui InputGroup (installed) / SidebarInput | history | #256 | migrated | — |

## Execution section

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SessionSidebarList team tree, session rows, empty states | `src/kubecode/SessionSidebarList.tsx:255-345,402-430` | SidebarGroup + SidebarMenu; a Team's Leader row and its teammates in SidebarMenuSub; count Badge; Empty | Sidebar SidebarMenuSub + Empty | history | #256 | migrated | — |
| Session row actions menu (archive/fork/rename/delete) | `src/kubecode/SessionSidebarList.tsx:439-492` | DropdownMenu on a SidebarMenuAction trigger | shadcn/ui DropdownMenu | session rows | #256 | migrated | — |
| Session filter/sort menu | `src/kubecode/SessionSidebarList.tsx:522-560` | DropdownMenu on a SidebarGroupAction trigger | shadcn/ui DropdownMenu | history | #256 | migrated | — |
| Channel threads and research navigators in history | `src/kubecode/channel/ChannelNavigator.tsx; src/kubecode/research/ResearchNavigator.tsx; WorkbenchShell.tsx:1120-1140` | SidebarGroup/SidebarGroupLabel/SidebarGroupAction + SidebarMenu; Spinner and Alert states | Sidebar SidebarMenu | history | #256 | migrated | — |

## Workspace nav

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Destination list items with counts | `src/kubecode/app/WorkspaceNav.tsx:69-96` | SidebarMenuButton (isActive + aria-current) + StatusBadge counts | SidebarMenuButton + SidebarMenuBadge | workspace routes | #256 | migrated | — |
| Roster members + DM icon buttons | `src/kubecode/app/WorkspaceNav.tsx:100-120` | SidebarGroup/SidebarMenu; MemberIdentity row with a SidebarMenuAction for the private message | SidebarGroup/SidebarMenu + Avatar | members, DMs | #256 | migrated | — |
| Direct messages list | `src/kubecode/app/WorkspaceNav.tsx:123-140` | SidebarMenuButton + MemberAvatar | SidebarMenuButton + Avatar | DM route | #256 | migrated | — |

## Headers

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DestinationHeader | `src/kubecode/app/DestinationHeader.tsx:40-55` | ViewHeader wrapper (level 2, destination glyph) | as ViewHeader | all destinations | #256 | exception | Composes the shared `ViewHeader`, the contract's exception (no registry page header; ADR 0247 §2) |

## Inspector

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Inspector stack pane (DetailPane aside, focus/Escape) | `src/kubecode/app/DetailPane.tsx:44; src/kubecode/app/inspector/InspectorPane.tsx:154-180` | DetailPane aside (focus on open, return to opener, Escape pops one level) holding the InspectorPane stack | shadcn/ui Sheet (phone) / Sidebar right / Resizable panel | inspect records | #256 | exception | ADR 0248 §6: no registry component is a non-modal, in-flow inspector that parks lower entries (`Sheet` is modal and portalled, a right `Sidebar` has one level, `Resizable` has no stack). Smallest adapter kept, covered by DetailPane.test and InspectorPane.test |
| InspectorPanel loading/notice states | `src/kubecode/app/inspector/InspectorPanel.tsx:34-50` | Spinner status (loading) / Empty status with recovery (unavailable) | Skeleton/Spinner + Alert/Empty (installed) | inspector panels | #256 | migrated | — |

## Loading

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Opening/route loading text | `src/kubecode/app/WorkbenchShell.tsx:1204,1235` | Empty + Spinner (`RouteOpening`); terminal without a Project is an Empty | Spinner/Skeleton (installed) | route transitions | #256 | migrated | — |

## Notifications

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser notification onboarding banner | `src/kubecode/app/WorkbenchShell.tsx:1396-1408` | Alert with its two Buttons | shadcn/ui Alert + action / Sonner toast | first run | #256 | migrated | — |
| Global toasts | `src/kubecode (no sonner/toast usage)` | none; errors via topbar icon and sr-only live region | shadcn/ui Sonner (not installed) | n/a | #256 | not-applicable | — |

## Accessibility

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sr-only announcement live region | `src/kubecode/app/WorkbenchShell.tsx:1056` | handcrafted sr-only status | none required | screen readers | #256 | not-applicable | Pure a11y live region, no visual component |

## Keyboard

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shortcuts: Cmd/Ctrl+K palette, focus navigator search, Escape closes overlays | `src/kubecode/app/WorkbenchShell.tsx:760-811` | document keydown listeners for Cmd/Ctrl+K (session search) and Cmd/Ctrl+Shift+P (palette); Escape is owned by Sheet/Dialog; Kbd hint in the search; SidebarProvider's Cmd/Ctrl+B turned off | Kbd (installed) for hints; CommandShortcut | global | #256 | exception | ADR 0248: no registry component registers application-wide shortcuts (the Sidebar's Cmd/Ctrl+B is turned off so Ctrl+B stays with the terminal and composer); the two listeners only open the palette and focus the search, and the navigation has one toggle, the title-bar button |

## Global search

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Workspace search launcher popover + trigger | `src/kubecode/resources/WorkspaceSearchLauncher.tsx:4,53-70` | official Popover + outline Button trigger | shadcn/ui Command in Popover / CommandDialog; Button trigger | title bar search slot | #258 | migrated | #258: Button trigger; Popover sized by layout classes |

## Workspace search

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Search combobox input | `src/kubecode/resources/WorkspaceSearch.tsx:164-176` | official Command (CommandInput) | shadcn/ui Command (CommandInput, installed) | ResourcesView, launcher, AddContextDialog | #258 | migrated | #258, ADR 0250: cmdk owns combobox/IME/active row; shouldFilter=false keeps server ranking |
| Section filter group | `src/kubecode/resources/WorkspaceSearch.tsx:222-240` | official ToggleGroup type=multiple + Badge counts | shadcn/ui ToggleGroup (not installed) or Tabs | same as search | #258 | migrated | #258: toggle-group added with shadcn CLI 4.22.1 |
| Scope note / notice text | `src/kubecode/resources/WorkspaceSearch.tsx:252,266` | Field-style muted note + shared ReaderNotice (Alert) | shadcn/ui Alert or Field description | same as search | #258 | migrated | #258: ReaderStates.tsx |
| Empty/loading/error/no-sections states | `src/kubecode/resources/WorkspaceSearch.tsx:271-284,334` | shared ReaderEmpty/ReaderLoading/ReaderNotice (Empty, Spinner, Alert) | shadcn/ui Empty, Spinner/Skeleton, Alert | same as search | #258 | migrated | #258: ReaderStates.tsx |
| Results listbox + options | `src/kubecode/resources/WorkspaceSearch.tsx:295-319` | official Command (CommandList/CommandGroup/CommandItem) with Item parts | shadcn/ui Command (CommandList/CommandGroup/CommandItem) with Item | ResourcesView, launcher, AddContextDialog | #258 | migrated | #258, ADR 0250 §2: pointermove adapter for focus-returned rows (cmdk gap, tested) |

## Resources route

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Attach bar (target banner, Attach/Cancel) | `src/kubecode/resources/ResourcesView.tsx:56-69` | official Alert with Buttons | shadcn/ui Alert with action or Item | Resources route | #258 | migrated | #258 |
| Destination header | `src/kubecode/resources/ResourcesView.tsx:49` | workspace DestinationHeader | n/a (layout) | Resources route | #255 | not-applicable | — |

## Resource inspector

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ResourcePanel shell/actions/badges/recovery | `src/kubecode/resources/ResourcePanel.tsx:80-118` | InspectorPanel + Button + Badge + ReaderNotice | shadcn/ui Sheet/Card, Badge, Button | Inspector registry | #258 | migrated | #258; InspectorPanel shell itself is #256 |

## Record preview

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Loading/removed/failed/notice states | `src/kubecode/resources/RecordPreview.tsx:145-196,228-234` | shared ReaderLoading/ReaderEmpty/ReaderNotice | shadcn/ui Skeleton/Spinner, Empty, Alert | ResourcePanel, EvidenceViewer | #258 | migrated | #258 |
| Code/markdown body | `src/kubecode/resources/RecordPreview.tsx:6-7` | official AI Elements CodeBlock + Streamdown | AI Elements CodeBlock / MessageResponse | ResourcePanel, EvidenceViewer | #258 | migrated | — |
| Sections and related-records list | `src/kubecode/resources/RecordPreview.tsx:201,245-252` | Item/ItemGroup; related records are Item buttons with focus keys | shadcn/ui Item/ItemGroup | ResourcePanel, EvidenceViewer | #258 | migrated | #258 |

## References

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ResourceReferenceChip wrapper | `src/kubecode/resources/ResourceReferenceChip.tsx:31` | ReferenceChip on official Attachment | AI Elements InlineCitation / ReferenceChip | composer, messages, results | #258 | migrated | #258, ADR 0250 §5: props unchanged; InlineCitation not used (no citation spans from the backend) |
| ReferenceSources collapsible list | `src/kubecode/resources/ReferenceSources.tsx:3,39-45` | AI Elements Sources + ReferenceChip list | AI Elements Sources + Source | MessageItem, TaskResults | #258 | migrated | #258, ADR 0250 §6: Source is an external link, so each source is a ReferenceChip |
| Message references list | `src/kubecode/channel/MessageItem.tsx:236` | handcrafted ul of ReferenceChip | AI Elements InlineCitation / Sources or Badge | MessageItem | #257/#263 | exception | #263: the task-only case is a semantic `ul` holding one official ReferenceChip (Attachment). ReferenceSources would announce "0 sources" for it, so the list stays; every cited record goes through ReferenceSources |

## Attach flows

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AddContextDialog (search, preview, back step, footer, refusal/error) | `src/kubecode/resources/AddContextDialog.tsx:4,138-230` | official Dialog + Command + DialogFooter + ReaderNotice; container-query layout classes | shadcn/ui Dialog, Command, DialogFooter, Alert | ResourcePanel, MessageComposer | #258 | migrated | #258 |
| ComposerAddMenu reference picker (file, git diff, work, turns, terminal) | `src/kubecode/ComposerAddMenu.tsx; src/kubecode/ComposerProjectWorkPicker.tsx` | official Popover (dismissal, focus return, stacking; inner panels and the work preview peel Escape one layer at a time) + Item rows (touch-sized) + Command for the capability search and the Project work list + shared ReaderStates | shadcn/ui Popover + Command; AI Elements PromptInputActionMenu | SessionComposer | #258 | migrated | #258: no handcrafted combobox remains; the capability row content is shared with the inline composer listbox (row 194, specialist engine) through CapabilityRowContent |
| Inline wikilink/mention context input | `src/kubecode/ComposerContextInput.tsx:3; src/components/InlineWikilinkInput.tsx:939` | specialist engine (contenteditable inline token editor) | AI Elements PromptInputTextarea + PromptInputCommand (no inline-token equivalent) | SessionComposer | #258 | specialist-engine | Inline tokens within editable text (944-line engine) have no registry equivalent |
| Composer attach-from-workspace / attach file | `src/kubecode/channel/MessageComposer.tsx:339,368,394,423` | PromptInputActionMenu (Add context) + PromptInput attachments; workspace references are ResourceReferenceChip (Attachment) in a layout-only list | AI Elements PromptInput attachments; ui/attachment | MessageComposer | #257/#263 | migrated | #263 audit: the menu is the official PromptInputActionMenu and every chip is the official Attachment through ReferenceChip; no CSS redraw remains (`.kubecode-add-context` is a layout hook only) |

## Evidence inspector

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| EvidencePanel shell + cannot-accept alert | `src/kubecode/work/EvidencePanel.tsx:3,59,69` | InspectorPanel + official Alert | shadcn/ui Alert | Inspector registry | #258 | migrated | — |
| EvidenceViewer (follow related record) | `src/kubecode/work/EvidenceViewer.tsx:54,66` | delegates to RecordPreview | see RecordPreview | EvidencePanel | #258 | migrated | #258 |

## General

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Message list scroller + scroll-to-bottom | `src/kubecode/channel/MessageList.tsx:4,268` | AI Elements Conversation wrapped in kubecode-message-list div | AI Elements Conversation/ConversationContent/ConversationScrollButton | ChannelWorkspace, DmPane | #257 | migrated | — |
| Message list loading / error states | `src/kubecode/channel/MessageList.tsx:294,297` | handcrafted p muted/error | shadcn Skeleton/Spinner; Alert (destructive) | ChannelWorkspace, DmPane | #257 | migrated | Spinner (loading) and Alert destructive with Retry (#257) |
| Empty conversation state | `src/kubecode/channel/MessageList.tsx:303-308` | official Empty + kubecode-conversation-empty class | shadcn Empty | ChannelWorkspace | #257 | migrated | — |
| Date separator | `src/kubecode/channel/MessageList.tsx:313` | handcrafted div role=separator | shadcn Separator with label | MessageList | #257 | migrated | Separator pair with label; layout via Tailwind (#257) |
| Activity group (collapsed system activity) | `src/kubecode/channel/ActivityGroup.tsx:13` | handcrafted details | shadcn Collapsible or AI Elements Task/ChainOfThought | MessageList | #257 | migrated | Collapsible; notes forceMount+hidden as anchors; revealActivity adapter (ADR 0249) |
| Message item: content/actions/header | `src/kubecode/channel/MessageItem.tsx:1,163` | official MessageContent/MessageActions + CSS redraw; handcrafted header | AI Elements Message/MessageContent/MessageActions | MessageList | #257 | migrated | Message/MessageContent/MessageActions; hover background, toolbar opacity CSS and content padding redraw removed; reveal via Tailwind group-hover/focus-within/pointer-coarse (#257). Remaining: self/member side layout rules from ADR 0239 |
| Message overflow menu (hidden actions) | `src/kubecode/channel/MessageItem.tsx:3` | MoreActions over shadcn DropdownMenu | shadcn DropdownMenu | MessageItem | #255 | migrated | — |
| Recipients line with arrow | `src/kubecode/channel/MessageItem.tsx:135-137` | handcrafted spans | shadcn Badge / Message header (no direct component) | MessageItem | #257 | migrated | Tailwind utilities on the Message header; legacy recipients CSS removed (#257) |
| Proposal text, delivery status (queued/failed) | `src/kubecode/channel/MessageItem.tsx:217,257,263` | handcrafted p with data-delivery | shadcn Badge; Alert for failed | MessageItem | #257 | migrated | Badge rows; legacy CSS removed (#257) |
| Message response markdown | `src/kubecode/channel/ConversationResponse.tsx:4,11` | official MessageResponse/Streamdown with inert-image span | AI Elements MessageResponse | MessageItem, DmPane | #257 | migrated | Inert image span is security hardening (streamdown-hardening.ts) |
| ConversationMessage wrapper | `src/kubecode/channel/ConversationMessage.tsx:3` | official component | AI Elements Message | MessageItem, OutboxRows | #257 | migrated | #263: the header row (author, recipients, intent Badge, MessageActions) is a layout adapter around official parts (ConversationIdentity on MemberAvatar + link Button, Badge, MessageActions); a failed delivery is the destructive Alert; queued/delivered lines are plain text |
| Reply citation jump | `src/kubecode/channel/MessageItem.tsx:208-222` | link Button with the reply glyph and a truncated excerpt | shadcn Button variant=link (AI Elements InlineCitation is a hover card, not a jump) | MessageItem | #263 | migrated | #263: was a raw `<button class="kubecode-channel-citation">` redrawn by CSS; CSS removed |
| Failed delivery line | `src/kubecode/channel/MessageItem.tsx:262-267` | destructive Alert (title Not delivered, description the reason) | shadcn Alert | MessageItem | #263 | migrated | #263: was a div with Badge + span |
| Outbox rows (pending/failed sends, retry) | `src/kubecode/channel/OutboxRows.tsx:25-39` | Message, Badge, Spinner inside handcrafted ul/li and status spans | AI Elements Message + Badge/Spinner/Alert; Queue | ChannelWorkspace | #257 | migrated | Message + Spinner; failure is a destructive Alert; ul/li are Tailwind layout only; all kubecode-outbox CSS removed (#257). Queue not used: rows are pending Messages (ADR 0242) |
| Header + task filter Select + filter chip | `src/kubecode/channel/ChannelWorkspace.tsx:315-345` | official Select in handcrafted filter div; DestinationHeader | shadcn Select + Badge | ChannelWorkspace | #257 | migrated | — |
| Load error / outside-channel notice / sr announcement | `src/kubecode/channel/ChannelWorkspace.tsx:355,394,401` | handcrafted p role=alert/status | shadcn Alert | ChannelWorkspace | #257 | migrated | Alert destructive / Alert role=status (#257) |
| Conversation dock | `src/kubecode/channel/ChannelWorkspace.tsx:403` | handcrafted layout div | not-applicable (layout) | ChannelWorkspace, DmPane | #257 | not-applicable | — |
| @mention popup | `src/kubecode/channel/ConversationComposer.tsx:230-254` | PromptInputCommand in absolutely positioned div; Avatar rows | AI Elements PromptInputCommand within shadcn Popover | ConversationComposer | #257 | migrated | PromptInputCommand in official Popover anchored to the composer (ADR 0249) |
| Composer hints/warnings/notice/gate, replying-to, About row | `src/kubecode/channel/MessageComposer.tsx:276-362` | handcrafted span/p | shadcn Alert / Badge; PromptInputHeader | ChannelWorkspace | #257 | migrated | Alert (status / destructive) for notices, blocked and gate; replying-to and About row as PromptInputHeader content with Tailwind; legacy CSS removed (#257) |
| Composer add (+) menu and clear-reply IconButton | `src/kubecode/channel/MessageComposer.tsx:306,385-400` | PromptInputActionMenu; IconButton | AI Elements PromptInputActionMenu; Button+Tooltip | MessageComposer | #257 | migrated | — |

## Legacy Threads

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Legacy thread link button in message | `src/kubecode/channel/MessageItem.tsx:241` | handcrafted button | shadcn Button variant=link | MessageItem | #257 | migrated | Button variant=link (#257) |
| Channel navigator (General + threads list) | `src/kubecode/channel/ChannelNavigator.tsx:26-50` | SidebarGroup + SidebarMenuButton (isActive) + StatusBadge | Sidebar menu / Item | ChannelWorkspace | #256 | migrated | — |
| Read-only legacy thread pane | `src/kubecode/channel/ThreadPane.tsx:134-212` | aside with ViewHeader, Alert (read-only note, link error) and the official Select for the Task link | shadcn Sheet/Card + Alert + Button | ChannelWorkspace | #257/#263 | exception | #263 audit: the native link selects were replaced by the official Select (ThreadPane.tsx:148); the pane is a non-modal in-flow detail like the inspector (ADR 0248 §6 exception) for a read-only legacy surface |

## General/DM

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Composer (PromptInput, send/stop) | `src/kubecode/channel/ConversationComposer.tsx:26,228,258-319` | PromptInput with kubecode-composer wrappers, stop text span and footer | AI Elements PromptInput/PromptInputSubmit/PromptInputFooter | MessageComposer, DmPane, #/controls | #257 | migrated | PromptInput card overrides removed; official look (ADR 0249) |

## DM

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DM pane conversation, turns, waiting shimmer, queued note | `src/kubecode/dm/DmPane.tsx:3-9,123-206` | Conversation/MessageContent/Shimmer with handcrafted turn/header divs | AI Elements Conversation/Message/Shimmer | DM route | #257 | migrated | Turns are ConversationMessage (official Message) pairs in a Tailwind flex column, as General; kubecode-dm-turn CSS removed; Shimmer; queued note is Badge (#257) |
| DM loading/error/status/warning text | `src/kubecode/dm/DmPane.tsx:143,160,163,236` | handcrafted p | shadcn Spinner/Alert | DmPane | #257 | migrated | Spinner / Alert (#257) |
| DmShareDialog shell | `src/kubecode/dm/DmShareDialog.tsx:160-165` | official Dialog | shadcn Dialog | DmPane | #257 | migrated | — |
| DmShareDialog turn chooser (checkbox fieldset) | `src/kubecode/dm/DmShareDialog.tsx:166-180` | native fieldset + checkbox | shadcn Checkbox + FieldSet (Checkbox not installed) | DmShareDialog | #257 | migrated | FieldSet + Field + Checkbox; only max-h/overflow utilities; kubecode-dm-turns/field CSS removed (#257) |
| DmShareDialog note textarea | `src/kubecode/dm/DmShareDialog.tsx:181-184` | official Textarea in handcrafted label | shadcn Textarea + Field/FieldLabel | DmShareDialog | #257 | migrated | Field + FieldLabel + Textarea |
| DmShareDialog task native select | `src/kubecode/dm/DmShareDialog.tsx:185-197` | native select | shadcn Select | DmShareDialog | #257 | migrated | shadcn Select with No-Task sentinel |
| DmShareDialog preview card, error, action row | `src/kubecode/dm/DmShareDialog.tsx:56-74,199-215` | handcrafted section/p + MarkdownContent + DecisionButton/ReferenceChip | shadcn Card, Alert, DialogFooter; MessageResponse | DmShareDialog | #257 | migrated | Card with its own surface (no kubecode-dm-preview redraw), Alert, Collapsible exact text, DialogFooter (#257) |

## Tasks

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task inspector loading / error with Retry | `src/kubecode/tasks/TaskPanel.tsx:121-128` | InspectorPanel loading; ReaderNotice (Alert destructive) + Button | Skeleton/Spinner; Alert (destructive) + Button | task inspector | #259 | migrated | — |
| Task header MoreActions menu, status meta | `src/kubecode/tasks/TaskPanel.tsx:175-177` | MoreActions over DropdownMenu | shadcn DropdownMenu | TaskPanel | #259 | migrated | — |
| Next-step banner + Discuss in General | `src/kubecode/tasks/TaskPanel.tsx:182-187` | official Alert (role group) + Button | shadcn Alert or Item | TaskPanel | #259 | migrated | — |
| Inline error paragraph | `src/kubecode/tasks/TaskPanel.tsx:189` | ReaderNotice → Alert destructive | shadcn Alert destructive | TaskPanel | #259 | migrated | — |
| Restore archived (DecisionButton) | `src/kubecode/tasks/TaskPanel.tsx:192` | DecisionButton (official Button + Spinner) | shadcn Button + Spinner | TaskPanel | #259 | migrated | — |
| Overview/Results/Activity tabs with review count badge | `src/kubecode/tasks/TaskPanel.tsx:197-212` | official Tabs + StatusBadge (Badge variants; ToneBadge removed in #255) | shadcn Tabs, Badge | TaskPanel | #259 | migrated | — |
| Archive blocked / archive confirm dialogs | `src/kubecode/tasks/TaskPanel.tsx:218-243` | official AlertDialog (added via CLI, ADR 0251) | shadcn AlertDialog (not installed) | TaskPanel | #259 | migrated | — |
| TaskStatusBadges + condition reason text | `src/kubecode/tasks/TaskStatusBadges.tsx:34-50` | StatusBadge (official Badge); reason a layout span | shadcn Badge | TaskPanel, TaskCardView | #259 | migrated | — |
| Waiting-on items list | `src/kubecode/tasks/TaskWork.tsx:87-94` | AI Elements Task/TaskContent/TaskItem | AI Elements Task | TaskWork | #259 | migrated | — |
| Delivery issue rows with Retry and refusal | `src/kubecode/tasks/TaskWork.tsx:39-57,125-127` | Item/ItemGroup; failed delivery an Alert destructive with Retry | shadcn Item/ItemGroup + Alert | TaskWork | #259 | migrated | — |
| Embedded ExecutionStrip scoped to task | `src/kubecode/tasks/TaskWork.tsx:123` | ExecutionStrip (Queue/Item/Alert), prompts off, scoped to the Task | AI Elements Queue | TaskWork | #259 | migrated | — |
| Waiting-on-you section, brief Discuss | `src/kubecode/tasks/TaskOverview.tsx:62-80` | Item outline + ItemActions per waiting thing | shadcn Alert or Item with ItemActions | TaskOverview | #259 | migrated | — |
| Goal / brief summary dl in Plan; Edit brief; notice | `src/kubecode/tasks/TaskOverview.tsx:86-150` | AI Elements Plan holding a semantic dl (Tailwind layout); ReaderNotice Alert | AI Elements Plan; Alert for notice | TaskOverview | #259 | migrated | — |
| Provenance quote | `src/kubecode/tasks/TaskOverview.tsx:163-169` | Item muted with ItemActions | Item or InlineCitation | TaskOverview | #259 | migrated | — |
| People list and empty text | `src/kubecode/tasks/TaskOverview.tsx:190-197` | MemberIdentity list; ReaderEmpty (Empty) | shadcn Item/ItemGroup + Avatar; Empty | TaskOverview | #259 | migrated | — |
| Progress work items with stage badges | `src/kubecode/tasks/TaskOverview.tsx:217-233` | AI Elements Task/TaskItem + StatusBadge | AI Elements Task | TaskOverview | #259 | migrated | — |
| Questions list with options and free answer | `src/kubecode/tasks/TaskQuestions.tsx:26-91` | Item per question; Field + FieldLabel + Textarea; ReaderNotice | Field + Textarea + Button; Item; Alert; Suggestion | TaskOverview | #259 | migrated | — |
| In-General empty activity note | `src/kubecode/tasks/TaskActivity.tsx:139` | ReaderEmpty (Empty) | shadcn Empty | TaskActivity | #259 | migrated | — |
| Decided status note with Show in General | `src/kubecode/tasks/TaskResults.tsx:74-83` | official Alert (role status, focused) + Button | shadcn Alert | TaskResults | #259 | migrated | — |
| Accepted outcome + evidence sources | `src/kubecode/tasks/TaskResults.tsx:103-122,185-186` | AI Elements Sources + Item + ReferenceChip | AI Elements Sources/Source | TaskResults | #259 | migrated | — |
| No results yet empty state | `src/kubecode/tasks/TaskResults.tsx:122` | ReaderEmpty (Empty) | shadcn Empty | TaskResults | #259 | migrated | — |
| Review history list / ReviewSummary | `src/kubecode/tasks/TaskResults.tsx:144-173` | Item outline in ItemGroup + StatusBadge | shadcn Item/ItemGroup + Badge | TaskResults | #259 | migrated | — |
| Review form removed-ack checkbox | `src/kubecode/tasks/TaskResults.tsx:359-361` | official Checkbox + Field horizontal (added via CLI) | shadcn Checkbox + Field (not installed) | TaskResults | #259 | migrated | — |
| Outcome radio fieldset | `src/kubecode/tasks/TaskResults.tsx:366-367,441-446` | FieldSet + FieldLegend + official RadioGroup, hint as FieldDescription | shadcn RadioGroup + FieldSet (not installed) | TaskResults | #259 | migrated | — |
| Feedback textarea + hint + error | `src/kubecode/tasks/TaskResults.tsx:379-389` | Field/FieldLabel/FieldDescription + Textarea; ReaderNotice | Field/FieldLabel/FieldDescription/FieldError + Textarea | TaskResults | #259 | migrated | — |
| Accept / request changes decision bar | `src/kubecode/tasks/TaskResults.tsx:398-399` | AI Elements Confirmation + DecisionButton | AI Elements Confirmation | TaskResults | #259 | migrated | — |
| Evidence row version check with Open | `src/kubecode/tasks/TaskResults.tsx:467-477` | official Item/ItemActions + Button | shadcn Item | TaskResults | #259 | migrated | — |
| Activity timeline (empty, steps, Show in General) | `src/kubecode/tasks/TaskActivity.tsx:40-52` | ordered list of Item outline; ReaderEmpty | ChainOfThought steps or Item list; Empty | TaskActivity | #259 | migrated | — |
| Recent in General: loading/error/empty/list | `src/kubecode/tasks/TaskActivity.tsx:129-147` | ReaderLoading, ReaderNotice, ReaderEmpty; Item asChild buttons | Skeleton/Spinner, Alert, Empty, Item | TaskActivity | #259 | migrated | — |
| Execution records / linked records disclosures | `src/kubecode/tasks/TaskActivity.tsx:175-183,228-242` | official Collapsible + ghost Button trigger, lazily filled | shadcn Collapsible or Accordion | TaskActivity | #259 | migrated | — |
| Imports and ResearchExportPanel inside records | `src/kubecode/tasks/TaskActivity.tsx:242,270` | delegated to research components | n/a here | TaskActivity | #258/#262 | not-applicable | — |

## Kanban

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Needs-you-only switch | `src/kubecode/tasks/TaskBoardView.tsx:118-120` | Field horizontal + Switch + FieldLabel | shadcn Switch + Field horizontal | TaskBoardView | #259 | migrated | — |
| Error/loading states | `src/kubecode/tasks/TaskBoardView.tsx:127-133` | Alert destructive + Retry; ReaderLoading (Spinner) | Alert; Skeleton/Spinner | TaskBoardView | #259 | migrated | — |
| Board empty state with Open General | `src/kubecode/tasks/TaskBoardView.tsx:136-140` | official Empty + Button | shadcn Empty | TaskBoardView | #259 | migrated | — |
| Drafts collapsible with draft rows | `src/kubecode/tasks/TaskBoardView.tsx:152-167` | Collapsible + Item asChild button rows | Collapsible + Item asChild / Button | TaskBoardView | #259 | migrated | — |
| Nothing needs you note | `src/kubecode/tasks/TaskBoardView.tsx:175` | Empty | shadcn Empty | TaskBoardView | #259 | migrated | — |
| Stage tabs (phone) / columns with count + column empty | `src/kubecode/tasks/TaskBoardView.tsx:179-213` | Tabs line; column section + StatusBadge; Empty per empty column | Tabs; no Kanban in core registry | TaskBoardView | #259 | exception | No shadcn/ui or AI Elements kanban; the four-column grid and the phone stage picker are a layout-only container query (ADR 0251) |
| Task card | `src/kubecode/tasks/TaskCardView.tsx:42-66` | official Card holding the card's single button | shadcn Card composition + Avatar/AvatarGroup | TaskBoardView | #259 | migrated | — |
| Archived collapsible rows | `src/kubecode/tasks/TaskBoardView.tsx:233-254` | Collapsible + Item asChild button rows | Collapsible + Item | TaskBoardView | #259 | migrated | — |

## Needs you

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Destination header + manager decisions list | `src/kubecode/attention/NeedsYouView.tsx:44-96` | official ItemGroup/Item + StatusBadge; DestinationHeader | shadcn Item | Needs you route | #259 | migrated | — |
| Decision/setup rows | `src/kubecode/attention/NeedsYouList.tsx:36-61` | Item asChild on the row button (ItemContent/ItemTitle/ItemDescription/ItemActions) | Item asChild with ItemContent/ItemTitle/ItemDescription | Needs you, bell | #259 | migrated | — |
| Loading / empty / load-error / Show all | `src/kubecode/attention/NeedsYouList.tsx:91-107` | Spinner line (no live region, ADR 0234), Empty, ReaderNotice Alert | Skeleton, Empty, Alert | Needs you | #259 | migrated | — |

## Execution feedback

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Permission prompt | `src/kubecode/attention/PermissionPrompt.tsx:65-104; PromptDecision.tsx` | AI Elements Confirmation; PromptOutcome (status / Alert destructive) | AI Elements Confirmation (+ Alert) | General, SessionComposer | #259 | migrated | — |
| Elicitation prompt form fields | `src/kubecode/attention/ElicitationPrompt.tsx:66-137` | Confirmation + Field/Input/Switch/Select; PromptOutcome | AI Elements Confirmation + shadcn Field | General, SessionComposer | #259 | migrated | — |
| Execution strip: summary trigger, popover, Queue, failed row + Dismiss | `src/kubecode/attention/ExecutionStrip.tsx:122-134,243-307` | Popover + Queue + Shimmer; failed turn an Alert destructive | AI Elements Queue, Shimmer; Popover; Alert | General, TaskWork | #259 | migrated | — |
| ExecutionRow (who, queued, state, stop) | `src/kubecode/attention/ExecutionRow.tsx:40-59` | QueueItem + Item + Shimmer + MemberIdentity + StopButton | AI Elements Queue + Item | ExecutionStrip | #259 | migrated | — |
| Round pause control + notice | `src/kubecode/attention/RoundPauseControl.tsx:46-53` | PauseButton (pressed Button); status line | shadcn Button/Toggle; Alert | TaskWork | #259 | migrated | — |
| Prompt outcome lines (recorded, not recorded, gone) | `src/kubecode/attention/PromptDecision.tsx` | PromptOutcome: status line or Alert destructive | Alert | PermissionPrompt, ElicitationPrompt | #259 | migrated | — |
| Team work board / inspector load, refresh, notice and empty states | `src/kubecode/work/WorkBoard.tsx`, `src/kubecode/work/WorkInspector.tsx` | ReaderLoading/ReaderNotice/ReaderEmpty (Spinner, Alert, Empty) | Alert, Empty, Spinner | TeamTasksView | #259 | migrated | Filters, columns and forms stay with #261 (TeamTasksView row) |

## Research questions

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Research linked threads panel + empty state | `src/kubecode/research/ResearchThreadsPanel.tsx:36-55` | ItemGroup/Item + Empty | shadcn Item + Empty | ResearchWorkspace, TaskActivity | #262 | migrated | ADR 0252 |
| Earlier thread research and round link | `src/kubecode/channel/ThreadPane.tsx:146-170` | Select + SelectGroup (was native select); note and link error are #257's Alert | shadcn Select | ChannelWorkspace | #262 | migrated | Taken over from #257; ADR 0252 |

## Members

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| View shell + Current/Defaults tabs | `src/kubecode/members/MembersView.tsx:69-91` | official Tabs in handcrafted section | shadcn/ui Tabs | members route | #260 | migrated | — |
| Roster header (h3 + description + Add member) | `src/kubecode/members/MemberRoster.tsx:294-303` | Item (ItemContent/ItemTitle/ItemDescription/ItemActions) + Button | Item header or Card CardHeader/CardAction | MembersView | #260 | migrated | — |
| Member list rows | `src/kubecode/members/MemberRoster.tsx:310-400` | Item variant outline in ul (li needs a list parent, so ItemGroup role=list div is not used); StatusBadge, IconButton | ItemGroup + Item, Badge, Button + Tooltip | MembersView | #260 | migrated | Legacy .kubecode-member-row CSS removed |
| Row actions: restart/replace provider, profile, DM | `src/kubecode/members/MemberRoster.tsx:355-400` | IconButton (official Button + Tooltip) | shadcn Button + Tooltip | MemberRoster | #260 | migrated | IconButton is the A-owned thin wrapper |
| Load error state with Retry | `src/kubecode/members/MemberRoster.tsx:158-162` | Alert destructive with Retry; Spinner loading status | shadcn Alert or Empty | MemberRoster | #260 | migrated | — |
| Add/edit member form | `src/kubecode/members/MemberRoster.tsx:170-255` | FieldGroup + Field, Input, Select, Textarea, Alert role=note for the manager lock, Field horizontal actions + Spinner | shadcn Field, FieldGroup | MemberRoster | #260 | migrated | — |
| Replace provider inline form | `src/kubecode/members/MemberRoster.tsx:270-290` | official Field + ProviderSelect + Button | shadcn Field + Select + Button | MemberRoster | #260 | migrated | — |
| ProviderSelect | `src/kubecode/members/ProviderSelect.tsx:22-33` | official Select | shadcn Select | MemberRoster, MemberDefaultsPanel | #260 | migrated | — |
| Defaults panel header + unsaved badge | `src/kubecode/members/MemberDefaultsPanel.tsx:122-129` | Item header + StatusBadge | Card header or Item; Badge | MembersView, SettingsDialog | #260 | migrated | — |
| Defaults fields, key/value rows, template FieldSet, Save/Discard | `src/kubecode/members/MemberDefaultsPanel.tsx:137-225` | FieldGroup/FieldSet, Field horizontal key/value rows with data-invalid + FieldError (aria-describedby), Alert note, Button + Spinner | FieldSet/FieldGroup, InputGroup, Button | MembersView, SettingsDialog | #260 | migrated | — |
| MemberPanel inspector content | `src/kubecode/members/MemberPanel.tsx:36-100` | Field horizontal facts, Alert for manager restrictions, Button aria-expanded for long instructions | Field horizontal, Collapsible, Badge | inspector registry | #260 | migrated | InspectorPanel shell stays #256 |
| ManagerSetupNotice | `src/kubecode/members/ManagerSetupNotice.tsx:56-75` | official Alert + Button; CSS redraw removed | shadcn Alert | General | #260 | migrated | — |

## Workspace setup

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ProjectDialog: mode switch, PathPicker, hidden toggle, error, loading/empty | `src/kubecode/app/ProjectDialog.tsx:153-200; src/kubecode/PathPicker.tsx:97-125` | Dialog + ToggleGroup (create/import) + PathPicker on Command (cmdk) + Toggle (hidden dirs) + Alert destructive | Dialog, ToggleGroup, Command, Alert, Toggle | WorkbenchShell, navigator, first run | #260 | migrated | PathPicker keeps its props for ProjectFilePicker/ContextWorkbench |

## Settings

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SettingsDialog shell + section nav | `src/kubecode/app/SettingsDialog.tsx:174-191` | Dialog + Tabs orientation=vertical (horizontal scroll strip below md) | Dialog + Tabs vertical / Sidebar | WorkbenchShell | #260 | migrated | — |
| General rows: color scheme, theme, fonts, size | `src/kubecode/app/SettingsDialog.tsx:192-285` | FieldGroup + Field responsive, FieldLabel htmlFor + FieldDescription aria-describedby, Select/Input | Field orientation=horizontal | SettingsDialog | #260 | migrated | — |
| Language switch | none (locale from browser) | not present | shadcn Select if added | n/a | #260 | not-applicable | No language selector component in src/kubecode at origin/main |
| Notifications rows | `src/kubecode/app/SettingsDialog.tsx:286-377` | Field responsive + Switch/Select; test result StatusBadge role=status | Field horizontal + Switch/Select | SettingsDialog | #260 | migrated | — |
| Agents: teammate chat Switch; readiness toolbar | `src/kubecode/app/SettingsDialog.tsx:378-417` | Field responsive + Switch; FieldSet + Buttons with Spinner | Field horizontal, Button | SettingsDialog | #260 | migrated | — |
| Agents: per-agent diagnostic details + rows | `src/kubecode/app/SettingsDialog.tsx:420-457,606-628` | Accordion type=multiple + Item rows + StatusBadge | Collapsible/Accordion + Item | SettingsDialog | #260 | migrated | — |
| RuntimeStatusPanel | `src/kubecode/app/SettingsDialog.tsx:542-604` | FieldSet + Button/Spinner, Alert (error/unavailable), Item outline counts | Spinner/Skeleton, Alert, Item/Card | SettingsDialog | #260 | migrated | — |
| Member defaults row + panel | `src/kubecode/app/SettingsDialog.tsx:465-480` | Field responsive + Button + FieldSeparator + MemberDefaultsPanel | Field horizontal | SettingsDialog | #260 | migrated | — |
| WeChat panel: status, connect, QR, verification, binding messages | `src/kubecode/app/WeChatSettingsPanel.tsx:200-345,410-420` | FieldSet/Field, Alert role=status for connection state, Item for QR, Field + Input for the code | Field, Alert, Spinner, InputOTP (not installed) | SettingsDialog | #260 | migrated | InputOTP not used: codes are variable length (maxLength 12) and InputOTP needs a fixed slot count; QR keeps a white backing for scanning |
| WeChat disconnect confirm | `src/kubecode/app/WeChatSettingsPanel.tsx:360-375` | shadcn AlertDialog (added via CLI) | shadcn AlertDialog (not installed) | WeChatSettingsPanel | #260 | migrated | — |
| WeChat active session Select | `src/kubecode/app/WeChatSettingsPanel.tsx:433-450` | official Select | shadcn Select | WeChatSettingsPanel | #260 | migrated | — |
| QuickPromptsEditor | `src/kubecode/app/WeChatSettingsPanel.tsx:500-574` | FieldSet + Field + Textarea + FieldError | Field + Textarea + Alert | WeChatSettingsPanel | #260 | migrated | — |
| Editor auto save Switch row | `src/kubecode/app/SettingsDialog.tsx:492-511` | Field responsive + Switch | Field horizontal + Switch | SettingsDialog | #260 | migrated | — |
| Terminal coming-soon placeholder | `src/kubecode/app/SettingsDialog.tsx:513-515` | shadcn Empty | shadcn Empty | SettingsDialog | #260 | migrated | — |
| DisableWorkspacesDialog | `src/kubecode/DisableWorkspacesDialog.tsx:100-110` | shadcn AlertDialog + Field responsive/Select per worktree + Alert + Empty + Spinner | shadcn AlertDialog | WorkbenchShell | #260 | migrated | — |

## Session

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| New Session dialog (agent/mode choice grid, fields, empty placeholders) | `src/kubecode/app/NewSessionDialog.tsx:174-278` | ToggleGroup, RadioGroup choice cards, Field, Empty (same component as the New Session dialog row under Team) | ToggleGroup, Field, Empty | WorkbenchShell, Session start | #261 | migrated | Listed in the #260 scope; handed to #261. Migrated in ADR 0253 |
| Message turn (bubble, copy/edit/retry/branch) | `src/components/AiMessage.tsx:11-31,446` | AI Elements Message/MessageActions; no CSS redraw of the prompt bubble | AI Elements Message | Session timeline | #261 | migrated | — |
| User prompt inline editor | `src/components/AiMessage.tsx:131-160` | official Textarea + Buttons in a layout-only form | Textarea + Button (or PromptInput) | AiMessage | #261 | migrated | — |
| Reasoning block | `src/components/AiMessage.tsx:17-21,222` | AI Elements Reasoning + Shimmer | AI Elements Reasoning | AiMessage | #261 | migrated | — |
| Tool-use group header / segments / working indicator | `src/components/AiMessage.tsx:262,387,410` | official Collapsible + ghost Button + Badge + Spinner; Shimmer working line | AI Elements Tool / Shimmer, Spinner | AiMessage | #261 | migrated | Terminal/Stack Trace now published (2026-10-23); deferred in ADR 0253 (new ANSI dependency, no parsed frames) |
| Markdown rendering | `src/kubecode/session/SessionMarkdown.tsx` | MessageResponse (Streamdown) | AI Elements MessageResponse | AiMessage | #261 | migrated | — |
| Tool action card | `src/components/AiActionCard.tsx:3-10` | AI Elements Tool + CodeBlock; ai-action-card CSS removed | AI Elements Tool, CodeBlock | AiMessage | #261 | migrated | — |
| Conversation scroller + scroll-to-bottom | `src/components/AiPanelChrome.tsx:9,487,552` | specialist engine react-virtuoso + handcrafted ArrowDown Button | AI Elements Conversation/ConversationScrollButton | SessionTimeline | #261 | specialist-engine | Virtualization of long transcripts (react-virtuoso); Conversation does not virtualize. Jump button is an official outline icon Button |
| Panel header / linked-context strip / empty hint | `src/components/AiPanelChrome.tsx:342-348,384,462-464` | header and context strip deleted (unused); empty hint is shadcn Empty | Item / Empty / Badge | AI panel | #261 | migrated | ADR 0253 |
| Prompt input (body, tools, submit, stop) | `src/components/AiPanelChrome.tsx:10-19,626-740` | PromptInputBody/Tools + InputGroup without restyling; StopButton | AI Elements PromptInput/PromptInputTextarea | SessionComposer | #261 | exception | WikilinkChatInput/ComposerContextInput is a contenteditable mention engine (specialist); PromptInputBody/Tools/Submit around it are official. #263 audit: no registry Prompt Input supports inline mention chips |
| Composer status/error lines | `src/components/AiPanelChrome.tsx:711-716` | FieldDescription / FieldError | Field description / Alert | AiPanelComposer | #261 | migrated | — |
| Composer wrapper, read-only revision banner, leader-review dock | `src/kubecode/session/SessionComposer.tsx:169-198` | layout wrapper; Alert for read-only and leader review | Alert / Confirmation | SessionWorkspace | #261 | migrated | — |
| Mode/model/config control menu | `src/kubecode/AgentControlMenu.tsx:102-200` | shadcn DropdownMenu (Sub + RadioGroup, CheckboxItem, disabled locked mode) | DropdownMenu (RadioGroup, Sub) or PromptInputSelect/ModelSelector | SessionComposer | #261 | migrated | ADR 0253 |
| Slash command suggestions | `src/kubecode/AcpCommandMenu.tsx:23-42` | shadcn Command list mirroring the composer selection | shadcn Command | SessionComposer | #261 | migrated | ADR 0253 |
| Side question panel | `src/kubecode/SideQuestionPanel.tsx:22-88` | Collapsible + Item list + Badge + Spinner | Collapsible / AI Elements Queue / Item | SessionComposer | #261 | migrated | — |
| System message notice | `src/kubecode/SystemMessageNotice.tsx:58-118` | shadcn Alert (destructive for errors) + icon Buttons | shadcn Alert | SessionComposer | #261 | migrated | — |
| Plan summary | `src/kubecode/session/SessionPlanSummary.tsx:4-35` | AI Elements Plan; no CSS redraw | AI Elements Plan | SessionComposer | #261 | migrated | — |
| Prompt queue dock | `src/kubecode/session/PromptQueueDock.tsx:4-18,75` | AI Elements Queue + Input/Button | AI Elements Queue | SessionWorkspace | #261 | migrated | — |
| Usage/context meter | `src/kubecode/session/UsageMeter.tsx:4-13,77` | AI Elements Context + Progress; no indicator recolouring | AI Elements Context | SessionTitlebar | #261 | migrated | — |
| Title, status dot, team view switch, overflow menu | `src/kubecode/session/SessionTitlebar.tsx:5-11,58-92` | DropdownMenu; single ToggleGroup for Chat/Team (a view switch with no tab panels); StatusBadge + decorative Spinner for run state | Tabs/ToggleGroup, Badge | SessionWorkspace | #261 | migrated | — |
| Subagent bubble | `src/kubecode/session/SubagentBubble.tsx:4-11,54` | AI Elements Task + Shimmer + Badge; trigger styled with utilities only | AI Elements Task | SessionTimeline | #261 | migrated | Registry search 2026-10-23: no Subagent element |
| Timeline wrapper, recreated-context divider | `src/kubecode/session/SessionTimeline.tsx:53,78` | layout wrapper; AI Elements Checkpoint for recreated context | Separator / AI Elements Checkpoint | SessionWorkspace | #261 | migrated | — |
| Revision navigator | `src/kubecode/session/RevisionNavigator.tsx:20-30` | shadcn ButtonGroup + ButtonGroupText | ButtonGroup / MessageBranch | SessionWorkspace | #261 | migrated | — |
| Empty state: agent readiness grid, start actions | `src/kubecode/session/SessionWorkspace.tsx:475-533` | shadcn Empty + Item per Agent + Buttons | Empty + Item/Card | session route | #261 | migrated | #263: Item content left-aligned inside Empty; Add project and New session are named by their visible labels (WCAG 2.5.3); the context panel and its toggle are off until a Project exists |
| Rename/fork dialogs and header | `src/kubecode/session/SessionWorkspace.tsx:7-16,632` | official Dialog + Input; the fallback `<header>` (used only when the shell gives no title bar slot) is a layout-only flex row holding the migrated SessionTitlebar | shadcn Dialog | SessionWorkspace | #261 | migrated | Header draws no control: `.kubecode-session-header` is flex/height/border layout only (contract §3 layout CSS); its contents are the Title bar row above |

## Team

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Delete team dialog | `src/kubecode/DeleteTeamDialog.tsx:3-12` | AlertDialog; stays open while deleting | Dialog (or AlertDialog) | SessionWorkspace | #261 | migrated | Done under #262 (deletion confirmations); ADR 0252 |
| Team workspace view + proposal dialog | `src/kubecode/TeamWorkspaceView.tsx:4-21,85` | official Dialog/Button | shadcn Dialog | SessionWorkspace | #261 | migrated | — |
| Team member overview tree | `src/kubecode/TeamSessionOverview.tsx:26-65` | Item (button) + StatusBadge per member | Item / Sidebar menu / Avatar | SessionWorkspace | #261 | migrated | — |
| Team setup form (goal, criteria, mode grid, budget) | `src/kubecode/team/TeamSetupView.tsx:114-170` | FieldGroup/Field, RadioGroup choice cards, ToggleGroup, Select, Alert | Field, RadioGroup/ToggleGroup | TeamWorkspaceView | #261 | migrated | — |
| Team leader permission/native options | `src/kubecode/team/TeamPermissionView.tsx:39-68` | FieldSet + Field + Switch/Select | Field + Switch | TeamSetupView | #261 | migrated | — |
| Lineup proposal card | `src/kubecode/team/TeamProposalView.tsx:13-61` | shadcn Card + Badge | Card + Badge | TeamWorkspaceView | #261 | migrated | — |
| Control center header, badges, metrics, needs-attention | `src/kubecode/team/TeamStatusView.tsx:74-224` | StatusBadge, Badge, Item metrics, Item attention rows, Field input | Badge, Card, Item, Alert | TeamWorkspaceView | #261 | migrated | — |
| Tasks tabs, activity, dependencies, detail dialog, status select | `src/kubecode/team/TeamTasksView.tsx:11-31,72-234` | Tabs, Item lists, Dialog + Item facts + StatusBadge, Select, AlertDialog | Tabs, Dialog, Select, Item | TeamWorkspaceView | #261 | migrated | — |
| Verification rounds list | `src/kubecode/team/TeamVerificationView.tsx:12-17` | Item + translated StatusBadge | Item/Badge or AI Elements Task | TeamWorkspaceView | #261 | migrated | — |
| Work board filters, attention chips, column headers | `src/kubecode/work/WorkBoard.tsx` | Select, Checkbox, single ToggleGroup, Badge counts; new Task form on Field/Input/Textarea | Select, Checkbox, ToggleGroup, Badge, Field | TeamTasksView, work route | #261 | migrated | Taken over from #259 (ADR 0253); no Kanban in the core registry, columns stay layout CSS |
| Work board card | `src/kubecode/work/WorkCardView.tsx` | official Card holding one native button (opens; draggable), Badges inside | shadcn Card (TaskCardView pattern, #259) | WorkBoard | #263 | migrated | #263: was `article role=button` with its own Enter/Space handler and a `.kubecode-work-card` redraw with `outline: none` |
| Work inspector forms (questions, assign, review, close, priority) | `src/kubecode/work/WorkInspector.tsx` | Field, Select, Input, Textarea | Field, Select, Input | WorkBoard | #261 | migrated | Taken over from #259 (ADR 0253) |
| Work inspector histories (dependencies, attempts, experiments, decisions, questions, evidence, reviews, deliveries) | `src/kubecode/work/WorkInspector.tsx:270-480,680-700` | named regions (`WorkSection`) holding ItemGroup/Item rows | shadcn Item/ItemGroup | WorkBoard | #263 | migrated | #263: was raw section/h4/ul/ol/li styled by `.kubecode-work-inspector h4/ul/li`; the facts `dl` stays as semantic HTML |
| New Session dialog (mode, kind, Agent, workspace, import list) | `src/kubecode/app/NewSessionDialog.tsx` | Dialog, ToggleGroup, RadioGroup choice cards, Field/Select/Input, Item list, Empty | Dialog, ToggleGroup, RadioGroup, Field, Item | session route | #261 | migrated | ADR 0253 |

#261 reconciliation: the 33 original #261 rows are all kept (none deleted, merged or re-owned); three rows were added (Work board, Work inspector, New Session dialog), giving 36; the #260 hand-off row for the New Session dialog arrived from main and is kept, giving 37. 35 are migrated, Prompt input is partial and the Conversation scroller is specialist-engine. Row-by-row before/after status and screenshots: [ui-g-acceptance-evidence.md](ui-g-acceptance-evidence.md).

## Context workbench

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Explorer/Editor/Diff primary tabs | `src/kubecode/ContextWorkbench.tsx:351-578` | official Tabs (`TabsList variant="line"`); tab-bar TabsTrigger redraw removed | shadcn Tabs | inspector | #262 | migrated | ADR 0252 |
| New file / New folder icon buttons | `src/kubecode/ContextWorkbench.tsx:392-393` | IconButton (Button + Tooltip) for search, new file, new folder, refresh | Button + Tooltip (IconButton) | ContextWorkbench | #262 | migrated | ADR 0252 |
| ExplorerSection collapsible header | `src/kubecode/ContextWorkbench.tsx:670-706` | Collapsible + ghost Button trigger + Badge count | shadcn Collapsible | ContextWorkbench | #262 | migrated | ADR 0252 |

## Git

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Create repository / no changes empty states | `src/kubecode/ContextWorkbench.tsx:409-419` | Empty (EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent) | shadcn Empty | ContextWorkbench | #262 | migrated | ADR 0252 |
| Git notices (conflict/status) | `src/kubecode/ContextWorkbench.tsx:423,438` | Alert role=status | shadcn Alert | ContextWorkbench | #262 | migrated | ADR 0252 |
| Change groups and rows with stage/unstage/discard | `src/kubecode/ContextWorkbench.tsx:708-832` | Button row (open diff) + IconButton actions; Badge group count; virtualised above 200 rows | Item/ItemGroup + Button + Tooltip (+ Collapsible) | ContextWorkbench | #262 | exception | Fixed-height virtualised rows (react-virtuoso) keep a 36 px Button row; Item adds padding/gap that breaks the fixed height. ADR 0252 §3 |
| Commit box | `src/kubecode/ContextWorkbench.tsx:471-474` | InputGroup + InputGroupInput + InputGroupButton (Enter commits outside IME composition) | InputGroup or Field + Button | ContextWorkbench | #262 | migrated | ADR 0252 |
| Discard changes confirmation | `src/kubecode/ContextWorkbench.tsx:626-668` | AlertDialog (discard changes, close unsaved file) | shadcn AlertDialog (not installed) | ContextWorkbench | #262 | migrated | ADR 0252; alert-dialog.tsx byte-identical to #259/#260 |

## Plan panel

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent plan list with status icons | `src/kubecode/ContextWorkbench.tsx:484-505` | ItemGroup + Item with plan status icon | AI Elements Plan or Queue | ContextWorkbench | #262 | migrated | ADR 0252 |

## File tree

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Project file tree (ARIA tree, keyboard nav) | `src/kubecode/ProjectFileTree.tsx:57-448` | lazy per-directory ARIA tree, virtualised above 200 rows, ghost Button rows | AI Elements File Tree (not installed) | ContextWorkbench | #262 | exception | AI Elements File Tree renders a fully loaded nested Collapsible tree with no lazy loading or virtualisation; the tree keeps its domain loader and keyboard model. ADR 0252 §3 |
| Loading/empty/error message | `src/kubecode/ProjectFileTree.tsx:403` | Spinner line; Alert role=status; IconButton excluded-files toggle | Empty / Spinner / Alert | ContextWorkbench | #262 | migrated | ADR 0252 |

## File dialogs

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| New file/folder EntryDialog | `src/kubecode/ContextWorkbench.tsx:870-1000,588-595` | official Dialog + PathPicker on Command; create error is Alert destructive | Dialog + Field + Command | ContextWorkbench | #262 | migrated | PathPicker on Command is a byte-identical copy of #260's file. ADR 0252 |
| Quick open with ProjectFilePicker/PathPicker | `src/kubecode/ContextWorkbench.tsx:600-624; src/kubecode/ProjectFilePicker.tsx:29` | Dialog + PathPicker on Command; excluded-files toggle is the official Toggle | CommandDialog/Command | ContextWorkbench, ComposerAddMenu, ProjectDialog | #262 | migrated | PathPicker on Command is a byte-identical copy of #260's file. ADR 0252 |

## Editor

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Editor toolbar (path, unsaved, save, close) | `src/kubecode/ContextWorkbench.tsx:539-552` | path text + Badge warning (unsaved) + Button + IconButton | ButtonGroup + Badge + Tooltip | ContextWorkbench | #262 | migrated | ADR 0252 |
| CodeMirror editor | `src/kubecode/CodeEditor.tsx:1-93` | specialist engine (CodeMirror 6) | none (CodeBlock is read-only) | ContextWorkbench | #262 | specialist-engine | Editable code has no shadcn/AI Elements equivalent; the chrome around it is official (ADR 0252 §3) |

## Diff

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Git diff viewer states and content | `src/kubecode/GitDiffView.tsx:30-50` | Empty/Spinner (loading), Empty (unavailable), Alert destructive + Retry (failed); diff text in a `pre` | AI Elements CodeBlock (diff) + Empty/Alert/Spinner | ContextWorkbench | #262 | migrated | Diff text stays a `pre`: the server bounds it and a highlighter would re-tokenize it whole (ADR 0252 §3) |

## Terminal

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xterm terminal view | `src/kubecode/TerminalView.tsx:1-171` | specialist engine (@xterm/xterm) | none (AI Elements Terminal is output-only) | terminal | #262 | specialist-engine | Interactive PTY requires xterm; split, width, empty, exited and error states are official (ADR 0252 §3) |
| Terminal navigator tree | `src/kubecode/TerminalWorkspace.tsx:435-596` | ARIA tree of split groups with dnd-kit reordering; Button rows, Input rename, DropdownMenu profiles; collapsible ResizablePanel width | Sidebar menu / Item | terminal | #262 | exception | SidebarMenu is a list without tree semantics or a sortable model (ADR 0252 §3). #263: row close buttons are always visible without hover (touch) and duplicate scrollbar rules were removed |
| Inline rename editor | `src/kubecode/TerminalWorkspace.tsx:590-626` | official Input | shadcn Input | terminal | #262 | migrated | — |
| New terminal profile menu | `src/kubecode/TerminalWorkspace.tsx:628-663` | official DropdownMenu | shadcn DropdownMenu | terminal | #262 | migrated | — |
| Split layout and resize handles | `src/kubecode/TerminalWorkspace.tsx:666-771; src/components/ResizeHandle.tsx` | ResizablePanelGroup per split + ResizablePanel + named ResizableHandle; ResizeHandle.tsx removed; empty/exited states Empty/Alert | shadcn Resizable (not installed) | terminal | #262 | migrated | ADR 0248 dependency; ADR 0252 |

## Research

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Research navigator list | `src/kubecode/research/ResearchNavigator.tsx:6-12,46` | SidebarGroup + SidebarMenu + SidebarMenuButton + StatusBadge | Sidebar menu / Item + Badge | history | #262 | migrated | Sidebar group + SidebarMenuButton + StatusBadge (#256). #263: legacy `.kubecode-research-nav-*`/`.kubecode-research-notice` CSS removed |
| Workspace header, tabs, loading/error, notices | `src/kubecode/research/ResearchWorkspace.tsx:127-272` | Tabs; Alert notices; Button link to pending decisions; ReaderLoading/ReaderNotice | Tabs + Alert + Empty + Button link | research route | #262 | migrated | ADR 0252; ReaderStates.tsx byte-identical to #258 |
| New research dialog | `src/kubecode/research/NewResearchDialog.tsx:68-103` | Dialog + FieldGroup/Field + Alert destructive | Dialog + Field | research route | #262 | migrated | ADR 0252 |
| Brief form and fields | `src/kubecode/research/ResearchBriefPanel.tsx:133-211` | FieldGroup/Field/FieldDescription + Alert; read view as labelled sections | Field/FieldGroup + Alert | research route | #262 | migrated | ADR 0252 |
| Discussion panel (sessions, Select, Textarea, log, errors) | `src/kubecode/research/ResearchDiscussionPanel.tsx:113-250` | ItemGroup/Item lists, Select + SelectGroup, Empty, Alert | Item, Field, Empty, Alert; Conversation for log | research route | #262 | migrated | ADR 0252; log entries are Items, not a Conversation (they are records, not chat) |
| Findings, suggested changes, pending outcomes, capture form | `src/kubecode/research/ResearchFindingsPanel.tsx:3-12,63-330` | ItemGroup/Item + DecisionButton + StatusBadge; FieldGroup capture form; Alert; Empty | Card/Item + Badge + Field + Alert; Sources/InlineCitation | research route | #262 | migrated | ADR 0252; finding source rows stay text lists of evidence ids |
| Rounds panel and start-round form | `src/kubecode/research/ResearchRoundsPanel.tsx:164-407` | FieldGroup + FieldSet/Checkbox (carry-over, imports, execution) + Select; rounds as Item with Collapsible execution | Checkbox/RadioGroup (not installed) + Field + Card | research route | #262 | migrated | ADR 0252; checkbox.tsx byte-identical to #259 |
| Import panel | `src/kubecode/research/ResearchImportPanel.tsx:98-430` | Field + Checkbox + Alert + Item + Table (before/after); reader states | Field + Checkbox + Alert; CodeBlock | research route, TaskActivity | #262 | migrated | ADR 0252; table.tsx added by CLI |
| Export panel | `src/kubecode/research/ResearchExportPanel.tsx:81-155` | FieldSet + Checkbox + Alert | Checkbox/RadioGroup + Alert + CodeBlock | research route, TaskActivity | #262 | migrated | ADR 0252 |
| AvailabilityBadge / StaleBadge | `src/kubecode/research/SourceBadge.tsx:11-29` | StatusBadge | shadcn Badge | research route | #255 | migrated | Became the official Badge through StatusBadge in #255 |

## Experiment runner

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Execution section, envelope, attention, cards, logs | `src/kubecode/research/ResearchExecutionSection.tsx:121-650` | Item cards, Alert notices, Field reconcile input, Empty, `pre` logs; reader states | Card + Badge + Alert; Task/Tool, CodeBlock/Terminal | research route | #262 | migrated | ADR 0252 |
| Cancel/reconcile confirmation | `src/kubecode/research/ResearchExecutionSection.tsx:545,656-672` | AlertDialog (cancel all); reconcile is an Alert group with Field | AlertDialog or AI Elements Confirmation | research route | #262 | migrated | ADR 0252 |
| Execution envelope fields | `src/kubecode/research/ExecutionEnvelopeFields.tsx:1-79` | FieldSet/FieldLegend/FieldGroup/Field/FieldError | Field/FieldError | research route | #262 | migrated | ADR 0252 |

## Shared primitive

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| StatusBadge | `src/components/workspace/StatusBadge.tsx` | official Badge; tone → success/info/warning/destructive/secondary variant | shadcn Badge | 24 consumers | #255 | migrated | ToneBadge (duplicate) removed |
| IconButton | `src/components/workspace/IconButton.tsx:40` | official Button size=icon + ActionTooltip on Tooltip | shadcn Button + Tooltip | app-wide (8) | #255 | migrated | — |
| ActionTooltip + actionTooltipRecovery | `src/components/ui/action-tooltip.tsx; src/components/ui/actionTooltipRecovery.ts` | thin wrapper over official Tooltip with focus/touch recovery | shadcn Tooltip | IconButton, SendButton | #255 | exception | Recovery handles Radix tooltip re-open after a menu closes; kept as the smallest adapter over the official Tooltip, see ADR 0247 (#263 audit: still needed, covered by tests) |
| MoreActions | `src/components/workspace/MoreActions.tsx:36` | official DropdownMenu + IconButton | shadcn DropdownMenu | headers, messages, tasks | #255 | migrated | — |
| DecisionButton | `src/components/workspace/DecisionButton.tsx` | official Button variants + official Spinner | Button / ConfirmationAction | 4 consumers | #255 | migrated | — |
| SendButton / StopButton / PauseButton | `src/components/workspace/SendButton.tsx` | official Button default/outline/secondary variants + official Spinner; no colour redraw | AI Elements PromptInputSubmit inside composers | AiPanelChrome, ExecutionRow, RoundPauseControl | #255 | migrated | Composers use PromptInputSubmit (#257, #261); these name a scoped run |
| ReferenceChip | `src/components/workspace/ReferenceChip.tsx` | official Badge (outline) + Button (ghost) open/remove | Badge / InlineCitation; Attachment | 8 consumers | #255 | migrated | — |
| MemberIdentity / MemberAvatar | `src/components/workspace/MemberIdentity.tsx` | official Avatar/AvatarFallback, link Button, Badge | shadcn Avatar + Badge | 6 consumers | #255 | migrated | — |
| ViewHeader | `src/components/workspace/ViewHeader.tsx:49-72` | header composition over tokens + IconButton | no registry page header; compose Item/Separator | DestinationHeader, InspectorPanel | #255 | exception | No shadcn page-header component exists; kept as a thin composition over tokens |
| Attachment | `src/components/ui/attachment.tsx:1-204` | local component in ui/ | AI Elements PromptInput attachments | 1 consumer | #255 | exception | #258 decision (ADR 0250 §5): ReferenceChip composes this Attachment; Prompt Input attachments are for uploaded files, which Kubecode has no service for (#263 audit: unchanged) |

## Config

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| components.json iconLibrary vs icon imports | `components.json; src/components/ui/{dialog,select,dropdown-menu}.tsx; ExecutionStrip.tsx` | lucide everywhere; @phosphor-icons/react removed | single iconLibrary (lucide) | all | #255 | migrated | — |

## Shared CSS

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tokens: legacy --surface-*/--text-*/--accent-* vs shadcn variables | `src/index.css; src/kubecode/kubecode.css` | one semantic layer on :root and [data-theme]; data-ws-components scoping removed | shadcn CSS variables only | all, including portals | #255 | migrated | Legacy primitives stay as the brand palette the layer maps from |
| Global overrides of Button/Input/SelectTrigger font-size and icon svg size | `src/kubecode/kubecode.css (former 84-90, 2270-2273)` | removed | Button size variants | every Button | #255 | migrated | — |
| !important overrides | `src/kubecode/kubecode.css` | listed in scripts/css-ownership-baseline.json with owners | component variants/className | various pages | #255 with #257-#262 | exception | #263: the baseline lists only the xterm viewport (specialist engine) and prefers-reduced-motion (accessibility); the hidden-scrollbar and record-code `!important` rules were removed |
| Per-page data-slot overrides (Tabs, Dialog, Select, Item, Field, Avatar, Progress, Alert, Empty, Plan, InputGroup) | `src/kubecode/kubecode.css` | listed in scripts/css-ownership-baseline.json with owners; pnpm lint blocks new ones | variants/className; remove slot redraws | Team, settings, tasks, needs-you, members, composer, conversation | #256-#263 | exception | #263: `scripts/css-ownership-baseline.json` holds 10 entries, all documented exceptions: popper zoom compensation (5, #255), no text selection on controls (2, #255), xterm viewport (1, #262), reduced motion (2, #255). The path-picker title, avatar fallback, member/resource row and record-code rules were removed |
| Area redraw selectors (ws-search, reference, record-preview, evidence, research, attach) | `src/kubecode/kubecode.css` | CSS redraw; ReferenceChip redraw removed in #255 | semantic tokens on official components | resources, research | #262/#263 | migrated | #258 removed ws-search, reference, record-preview, evidence and attach rules; #263 removed the research navigator/notice redraw and the record-code rules. What remains (`.kubecode-research-workspace/-muted/-error`) lays out product elements only |

## Portals

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Popover/Dialog/Select/HoverCard/Command/Sheet/Tooltip/DropdownMenu theming | `src/components/ui/*.tsx; src/index.css` | official components; root token layer so portals inherit | shadcn/ui same | all overlays | #255 | migrated | — |

## ui primitives

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| accordion … tooltip (33 installed shadcn/ui components) | `src/components/ui/*.tsx` | official shadcn/ui components on lucide | ui.shadcn.com components | app-wide | #255 | migrated | Badge gains success/info/warning variants (ADR 0247) |

## ai-elements

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chain-of-thought … tool (17 AI Elements) | `src/components/ai-elements/*.tsx` | official AI Elements from @ai-elements | ai-sdk.dev/elements | #257, #259, #261 | #255 | migrated | streamdown-hardening.ts is a security helper |

## Dev

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #/controls ControlMatrix + OfficialComponentMatrix | `src/main.tsx:14; src/components/workspace/ControlMatrix.tsx; OfficialComponentMatrix.tsx` | renders the production wrappers and the production ConversationComposer | n/a (dev gallery) | matrix route | #255 | not-applicable | Internal verification route; no demo-only duplicates since #255 |
| WorkspacePrototypes (Agents/General/Review) | `src/components/workspace/prototypes/*.tsx` | prototype routes | n/a | prototypeRoute | #255/#263 | not-applicable | Prototype-only |
