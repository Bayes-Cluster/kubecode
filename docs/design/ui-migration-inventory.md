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
| migrated | 76 |
| partial | 92 |
| handcrafted | 64 |
| specialist-engine | 4 |
| exception | 1 |
| not-applicable | 8 |

| Owner | Rows |
| --- | ---: |
| #255 | 20 |
| #255 with #257-#262 | 1 |
| #255/#263 | 1 |
| #256 | 32 |
| #256-#262 | 1 |
| #257 | 28 |
| #258 | 19 |
| #258/#262 | 1 |
| #259 | 46 |
| #260 | 28 |
| #261 | 33 |
| #262 | 35 |

## Shell

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WorkbenchShell layout root (main.kubecode-app / .kubecode-workspace / main stack) | `src/kubecode/app/WorkbenchShell.tsx:1054,1098,1197` | handcrafted markup + kubecode.css | shadcn/ui Sidebar (SidebarProvider/SidebarInset) + Resizable | all workspace routes | #256 | handcrafted | — |
| Panel resize handles | `src/components/ResizeHandle.tsx:9; src/kubecode/app/ProjectNavigator.tsx:790; WorkbenchShell.tsx:7` | handcrafted mouse-drag div | shadcn/ui Resizable (ResizablePanelGroup/ResizableHandle) | navigator, main stack, terminal | #256 | handcrafted | Deferred from #255: shadcn Resizable needs `react-resizable-panels`, a new dependency that needs its own ADR. #256 writes that ADR with the shell layout migration; #262's terminal split follows it |

## Phone

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Navigator/context overlay 'sheet' + scrim button | `src/kubecode/app/WorkbenchShell.tsx:410,1099-1104` | handcrafted CSS overlay + raw button scrim; no Sheet used | shadcn/ui Sheet (installed) or Sidebar mobile mode | narrow layout | #256 | handcrafted | — |

## Title bar

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WorkbenchTitlebar header, project/place breadcrumb | `src/kubecode/app/WorkbenchTitlebar.tsx:110-130` | handcrafted spans with '/' separator | shadcn/ui Breadcrumb (not installed) | all routes | #256 | handcrafted | — |
| Topbar error indicator | `src/kubecode/app/WorkbenchTitlebar.tsx:140-146` | handcrafted span with CircleAlert + aria-label | shadcn/ui Tooltip + Badge or Alert | global errors | #256 | handcrafted | — |
| Notification bell (Needs you) menu: labels, entries with StatusBadge, show all, other workspaces, separator | `src/kubecode/app/WorkbenchTitlebar.tsx:149-210` | official DropdownMenu + Button + StatusBadge; entry body handcrafted span; CSS redraw (.kubecode-attention-*) | shadcn/ui DropdownMenu + Badge | Needs you entries, other workspaces | #256 | partial | — |
| Runtime connection menu (status rows, retry) | `src/kubecode/app/WorkbenchTitlebar.tsx:239-270` | official DropdownMenu with handcrafted div rows inside | shadcn/ui DropdownMenu + Item/Badge | event stream state | #256 | partial | — |
| Layout toggles (navigation/terminal/context) | `src/kubecode/app/WorkbenchTitlebar.tsx:210-215,284-295` | official Button with aria-pressed + CSS redraw | shadcn/ui Toggle / ToggleGroup (not installed) | shell panels | #256 | partial | — |

## Global command

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Global command palette (Cmd/Ctrl+K) | `src/kubecode/GlobalCommandPalette.tsx:99,299-370; WorkbenchShell.tsx:770-786` | official Dialog + Input with handcrafted listbox, arrow keys and status messages | shadcn/ui CommandDialog/Command (installed) | whole app | #256 | partial | — |
| Palette loading/empty/error states | `src/kubecode/GlobalCommandPalette.tsx:354-370` | handcrafted p role=status | CommandEmpty / Spinner | palette | #256 | handcrafted | — |

## Navigator

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ProjectNavigator heading actions (add project, settings, help) | `src/kubecode/app/ProjectNavigator.tsx:105-110` | official Button icon-xs; help button has no handler/tooltip | shadcn/ui Button + Tooltip (IconButton) | sidebar | #256 | partial | — |
| Workspace (project) switcher list rows + status | `src/kubecode/app/WorkspaceList.tsx:57-115` | official Button rows in handcrafted ul/li + CSS redraw | shadcn/ui SidebarMenu/SidebarMenuButton/SidebarMenuAction | sidebar | #256 | partial | — |
| Project row actions hidden menu (new session, toggle workspaces, delete) | `src/kubecode/app/WorkspaceList.tsx:82-105` | official DropdownMenu | shadcn/ui DropdownMenu | WorkspaceList | #256 | migrated | — |
| No-project empty text | `src/kubecode/app/WorkspaceList.tsx:48; WorkbenchShell.tsx:1378` | handcrafted p/div .kubecode-empty-small | shadcn/ui Empty (installed) | sidebar, main | #256 | handcrafted | — |
| History section collapsible | `src/kubecode/app/ProjectNavigator.tsx:126-138` | native details/summary + CSS | shadcn/ui Collapsible (installed) / SidebarGroup | sidebar | #256 | handcrafted | — |
| History session search input | `src/kubecode/app/ProjectNavigator.tsx:139-150` | official Input with handcrafted icon wrapper | shadcn/ui InputGroup (installed) / SidebarInput | history | #256 | partial | — |

## Execution section

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SessionSidebarList team tree, session rows, empty states | `src/kubecode/SessionSidebarList.tsx:255-345,402-430` | official Button rows in handcrafted div tree + .kubecode-empty-small | Sidebar SidebarMenuSub + Empty | history | #256 | partial | — |
| Session row actions menu (archive/fork/rename/delete) | `src/kubecode/SessionSidebarList.tsx:439-492` | official DropdownMenu | shadcn/ui DropdownMenu | session rows | #256 | migrated | — |
| Session filter/sort menu | `src/kubecode/SessionSidebarList.tsx:522-560` | official DropdownMenu radio/checkbox | shadcn/ui DropdownMenu | history | #256 | migrated | — |
| Channel threads and research navigators in history | `src/kubecode/channel/ChannelNavigator.tsx; src/kubecode/research/ResearchNavigator.tsx; WorkbenchShell.tsx:1120-1140` | handcrafted lists | Sidebar SidebarMenu | history | #256 | handcrafted | — |

## Workspace nav

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Destination list items with counts | `src/kubecode/app/WorkspaceNav.tsx:69-96` | raw button .kubecode-research-nav-item + StatusBadge | SidebarMenuButton + SidebarMenuBadge | workspace routes | #256 | handcrafted | — |
| Roster members + DM icon buttons | `src/kubecode/app/WorkspaceNav.tsx:100-120` | handcrafted list + Identity + IconButton (official Button+Tooltip) | SidebarGroup/SidebarMenu + Avatar | members, DMs | #256 | partial | — |
| Direct messages list | `src/kubecode/app/WorkspaceNav.tsx:123-140` | raw button + MemberAvatar | SidebarMenuButton + Avatar | DM route | #256 | handcrafted | — |

## Headers

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DestinationHeader | `src/kubecode/app/DestinationHeader.tsx:40-55` | ViewHeader wrapper | as ViewHeader | all destinations | #256 | handcrafted | — |

## Inspector

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Inspector stack pane (DetailPane aside, focus/Escape) | `src/kubecode/app/DetailPane.tsx:44; src/kubecode/app/inspector/InspectorPane.tsx:154-180` | handcrafted aside + sections | shadcn/ui Sheet (phone) / Sidebar right / Resizable panel | inspect records | #256 | handcrafted | — |
| InspectorPanel loading/notice states | `src/kubecode/app/inspector/InspectorPanel.tsx:34-50` | handcrafted p role=status | Skeleton/Spinner + Alert/Empty (installed) | inspector panels | #256 | handcrafted | — |

## Loading

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Opening/route loading text | `src/kubecode/app/WorkbenchShell.tsx:1204,1235` | handcrafted div role=status | Spinner/Skeleton (installed) | route transitions | #256 | handcrafted | — |

## Notifications

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser notification onboarding banner | `src/kubecode/app/WorkbenchShell.tsx:1396-1408` | handcrafted aside + official Buttons | shadcn/ui Alert + action / Sonner toast | first run | #256 | partial | — |
| Global toasts | `src/kubecode (no sonner/toast usage)` | none; errors via topbar icon and sr-only live region | shadcn/ui Sonner (not installed) | n/a | #256 | not-applicable | — |

## Accessibility

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sr-only announcement live region | `src/kubecode/app/WorkbenchShell.tsx:1056` | handcrafted sr-only status | none required | screen readers | #256 | not-applicable | Pure a11y live region, no visual component |

## Keyboard

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shortcuts: Cmd/Ctrl+K palette, focus navigator search, Escape closes overlays | `src/kubecode/app/WorkbenchShell.tsx:760-811` | document keydown listeners; no Kbd hints | Kbd (installed) for hints; CommandShortcut | global | #256 | partial | — |

## Global search

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Workspace search launcher popover + trigger | `src/kubecode/resources/WorkspaceSearchLauncher.tsx:4,53-70` | official Popover + outline Button trigger | shadcn/ui Command in Popover / CommandDialog; Button trigger | title bar search slot | #258 | migrated | #258: Button trigger; Popover sized by layout classes |

## Workspace search

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Search combobox input | `src/kubecode/resources/WorkspaceSearch.tsx:164-176` | official Command (CommandInput) | shadcn/ui Command (CommandInput, installed) | ResourcesView, launcher, AddContextDialog | #258 | migrated | #258, ADR 0248: cmdk owns combobox/IME/active row; shouldFilter=false keeps server ranking |
| Section filter group | `src/kubecode/resources/WorkspaceSearch.tsx:222-240` | official ToggleGroup type=multiple + Badge counts | shadcn/ui ToggleGroup (not installed) or Tabs | same as search | #258 | migrated | #258: toggle-group added with shadcn CLI 4.22.1 |
| Scope note / notice text | `src/kubecode/resources/WorkspaceSearch.tsx:252,266` | Field-style muted note + shared ReaderNotice (Alert) | shadcn/ui Alert or Field description | same as search | #258 | migrated | #258: ReaderStates.tsx |
| Empty/loading/error/no-sections states | `src/kubecode/resources/WorkspaceSearch.tsx:271-284,334` | shared ReaderEmpty/ReaderLoading/ReaderNotice (Empty, Spinner, Alert) | shadcn/ui Empty, Spinner/Skeleton, Alert | same as search | #258 | migrated | #258: ReaderStates.tsx |
| Results listbox + options | `src/kubecode/resources/WorkspaceSearch.tsx:295-319` | official Command (CommandList/CommandGroup/CommandItem) with Item parts | shadcn/ui Command (CommandList/CommandGroup/CommandItem) with Item | ResourcesView, launcher, AddContextDialog | #258 | migrated | #258, ADR 0248 §2: pointermove adapter for focus-returned rows (cmdk gap, tested) |

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
| ResourceReferenceChip wrapper | `src/kubecode/resources/ResourceReferenceChip.tsx:31` | ReferenceChip on official Attachment | AI Elements InlineCitation / ReferenceChip | composer, messages, results | #258 | migrated | #258, ADR 0248 §5: props unchanged; InlineCitation not used (no citation spans from the backend) |
| ReferenceSources collapsible list | `src/kubecode/resources/ReferenceSources.tsx:3,39-45` | AI Elements Sources + ReferenceChip list | AI Elements Sources + Source | MessageItem, TaskResults | #258 | migrated | #258, ADR 0248 §6: Source is an external link, so each source is a ReferenceChip |
| Message references list | `src/kubecode/channel/MessageItem.tsx:236` | handcrafted ul of ReferenceChip | AI Elements InlineCitation / Sources or Badge | MessageItem | #258 | partial | #258: ReferenceSources and ReferenceChip migrated; the task-only list in MessageItem is in a #257 file, requested of #257 |

## Attach flows

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AddContextDialog (search, preview, back step, footer, refusal/error) | `src/kubecode/resources/AddContextDialog.tsx:4,138-230` | official Dialog + Command + DialogFooter + ReaderNotice; container-query layout classes | shadcn/ui Dialog, Command, DialogFooter, Alert | ResourcePanel, MessageComposer | #258 | migrated | #258 |
| ComposerAddMenu reference picker (file, git diff, work, turns, terminal) | `src/kubecode/ComposerAddMenu.tsx; src/kubecode/ComposerProjectWorkPicker.tsx` | official Popover (dismissal, focus return, stacking; inner panels and the work preview peel Escape one layer at a time) + Item rows (touch-sized) + Command for the capability search and the Project work list + shared ReaderStates | shadcn/ui Popover + Command; AI Elements PromptInputActionMenu | SessionComposer | #258 | migrated | #258: no handcrafted combobox remains; the capability row content is shared with the inline composer listbox (row 194, specialist engine) through CapabilityRowContent |
| Inline wikilink/mention context input | `src/kubecode/ComposerContextInput.tsx:3; src/components/InlineWikilinkInput.tsx:939` | specialist engine (contenteditable inline token editor) | AI Elements PromptInputTextarea + PromptInputCommand (no inline-token equivalent) | SessionComposer | #258 | specialist-engine | Inline tokens within editable text (944-line engine) have no registry equivalent |
| Composer attach-from-workspace / attach file | `src/kubecode/channel/MessageComposer.tsx:339,368,394,423` | AI Elements PromptInput attachments + workspace menu | AI Elements PromptInput attachments; ui/attachment | MessageComposer | #257 | partial | — |

## Evidence inspector

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| EvidencePanel shell + cannot-accept alert | `src/kubecode/work/EvidencePanel.tsx:3,59,69` | InspectorPanel + official Alert | shadcn/ui Alert | Inspector registry | #258 | migrated | — |
| EvidenceViewer (follow related record) | `src/kubecode/work/EvidenceViewer.tsx:54,66` | delegates to RecordPreview | see RecordPreview | EvidencePanel | #258 | migrated | #258 |

## General

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Message list scroller + scroll-to-bottom | `src/kubecode/channel/MessageList.tsx:4,268` | AI Elements Conversation wrapped in kubecode-message-list div | AI Elements Conversation/ConversationContent/ConversationScrollButton | ChannelWorkspace, DmPane | #257 | migrated | — |
| Message list loading / error states | `src/kubecode/channel/MessageList.tsx:294,297` | handcrafted p muted/error | shadcn Skeleton/Spinner; Alert (destructive) | ChannelWorkspace, DmPane | #257 | handcrafted | — |
| Empty conversation state | `src/kubecode/channel/MessageList.tsx:303-308` | official Empty + kubecode-conversation-empty class | shadcn Empty | ChannelWorkspace | #257 | migrated | — |
| Date separator | `src/kubecode/channel/MessageList.tsx:313` | handcrafted div role=separator | shadcn Separator with label | MessageList | #257 | partial | — |
| Activity group (collapsed system activity) | `src/kubecode/channel/ActivityGroup.tsx:13` | handcrafted details | shadcn Collapsible or AI Elements Task/ChainOfThought | MessageList | #257 | handcrafted | — |
| Message item: content/actions/header | `src/kubecode/channel/MessageItem.tsx:1,163` | official MessageContent/MessageActions + CSS redraw; handcrafted header | AI Elements Message/MessageContent/MessageActions | MessageList | #257 | partial | — |
| Message overflow menu (hidden actions) | `src/kubecode/channel/MessageItem.tsx:3` | MoreActions over shadcn DropdownMenu | shadcn DropdownMenu | MessageItem | #255 | migrated | — |
| Recipients line with arrow | `src/kubecode/channel/MessageItem.tsx:135-137` | handcrafted spans | shadcn Badge / Message header (no direct component) | MessageItem | #257 | handcrafted | — |
| Proposal text, delivery status (queued/failed) | `src/kubecode/channel/MessageItem.tsx:217,257,263` | handcrafted p with data-delivery | shadcn Badge; Alert for failed | MessageItem | #257 | handcrafted | — |
| Message response markdown | `src/kubecode/channel/ConversationResponse.tsx:4,11` | official MessageResponse/Streamdown with inert-image span | AI Elements MessageResponse | MessageItem, DmPane | #257 | migrated | Inert image span is security hardening (streamdown-hardening.ts) |
| ConversationMessage wrapper | `src/kubecode/channel/ConversationMessage.tsx:3` | official component | AI Elements Message | MessageItem, OutboxRows | #257 | migrated | — |
| Outbox rows (pending/failed sends, retry) | `src/kubecode/channel/OutboxRows.tsx:25-39` | Message, Badge, Spinner inside handcrafted ul/li and status spans | AI Elements Message + Badge/Spinner/Alert; Queue | ChannelWorkspace | #257 | partial | — |
| Header + task filter Select + filter chip | `src/kubecode/channel/ChannelWorkspace.tsx:315-345` | official Select in handcrafted filter div; DestinationHeader | shadcn Select + Badge | ChannelWorkspace | #257 | migrated | — |
| Load error / outside-channel notice / sr announcement | `src/kubecode/channel/ChannelWorkspace.tsx:355,394,401` | handcrafted p role=alert/status | shadcn Alert | ChannelWorkspace | #257 | handcrafted | — |
| Conversation dock | `src/kubecode/channel/ChannelWorkspace.tsx:403` | handcrafted layout div | not-applicable (layout) | ChannelWorkspace, DmPane | #257 | not-applicable | — |
| @mention popup | `src/kubecode/channel/ConversationComposer.tsx:230-254` | PromptInputCommand in absolutely positioned div; Avatar rows | AI Elements PromptInputCommand within shadcn Popover | ConversationComposer | #257 | partial | — |
| Composer hints/warnings/notice/gate, replying-to, About row | `src/kubecode/channel/MessageComposer.tsx:276-362` | handcrafted span/p | shadcn Alert / Badge; PromptInputHeader | ChannelWorkspace | #257 | handcrafted | — |
| Composer add (+) menu and clear-reply IconButton | `src/kubecode/channel/MessageComposer.tsx:306,385-400` | PromptInputActionMenu; IconButton | AI Elements PromptInputActionMenu; Button+Tooltip | MessageComposer | #257 | migrated | — |

## Legacy Threads

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Legacy thread link button in message | `src/kubecode/channel/MessageItem.tsx:241` | handcrafted button | shadcn Button variant=link | MessageItem | #257 | handcrafted | — |
| Channel navigator (General + threads list) | `src/kubecode/channel/ChannelNavigator.tsx:26-50` | handcrafted ul/span with StatusBadge | Sidebar menu / Item | ChannelWorkspace | #256 | handcrafted | — |
| Read-only legacy thread pane | `src/kubecode/channel/ThreadPane.tsx:134-212` | handcrafted aside/p/div with Button and ViewHeader | shadcn Sheet/Card + Alert + Button | ChannelWorkspace | #257 | partial | — |

## General/DM

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Composer (PromptInput, send/stop) | `src/kubecode/channel/ConversationComposer.tsx:26,228,258-319` | PromptInput with kubecode-composer wrappers, stop text span and footer | AI Elements PromptInput/PromptInputSubmit/PromptInputFooter | MessageComposer, DmPane, #/controls | #257 | partial | — |

## DM

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DM pane conversation, turns, waiting shimmer, queued note | `src/kubecode/dm/DmPane.tsx:3-9,123-206` | Conversation/MessageContent/Shimmer with handcrafted turn/header divs | AI Elements Conversation/Message/Shimmer | DM route | #257 | partial | — |
| DM loading/error/status/warning text | `src/kubecode/dm/DmPane.tsx:143,160,163,236` | handcrafted p | shadcn Spinner/Alert | DmPane | #257 | handcrafted | — |
| DmShareDialog shell | `src/kubecode/dm/DmShareDialog.tsx:160-165` | official Dialog | shadcn Dialog | DmPane | #257 | migrated | — |
| DmShareDialog turn chooser (checkbox fieldset) | `src/kubecode/dm/DmShareDialog.tsx:166-180` | native fieldset + checkbox | shadcn Checkbox + FieldSet (Checkbox not installed) | DmShareDialog | #257 | handcrafted | — |
| DmShareDialog note textarea | `src/kubecode/dm/DmShareDialog.tsx:181-184` | official Textarea in handcrafted label | shadcn Textarea + Field/FieldLabel | DmShareDialog | #257 | partial | — |
| DmShareDialog task native select | `src/kubecode/dm/DmShareDialog.tsx:185-197` | native select | shadcn Select | DmShareDialog | #257 | handcrafted | — |
| DmShareDialog preview card, error, action row | `src/kubecode/dm/DmShareDialog.tsx:56-74,199-215` | handcrafted section/p + MarkdownContent + DecisionButton/ReferenceChip | shadcn Card, Alert, DialogFooter; MessageResponse | DmShareDialog | #257 | partial | — |

## Tasks

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task inspector loading / error with Retry | `src/kubecode/tasks/TaskPanel.tsx:121-128` | InspectorPanel loading; handcrafted p role=alert + Button | Skeleton/Spinner; Alert (destructive) + Button | task inspector | #259 | partial | — |
| Task header MoreActions menu, status meta | `src/kubecode/tasks/TaskPanel.tsx:175-177` | MoreActions over DropdownMenu | shadcn DropdownMenu | TaskPanel | #259 | migrated | — |
| Next-step banner + Discuss in General | `src/kubecode/tasks/TaskPanel.tsx:182-187` | handcrafted div role=group + p + Button | shadcn Alert or Item | TaskPanel | #259 | partial | — |
| Inline error paragraph | `src/kubecode/tasks/TaskPanel.tsx:189` | handcrafted p role=alert | shadcn Alert destructive | TaskPanel | #259 | handcrafted | — |
| Restore archived (DecisionButton) | `src/kubecode/tasks/TaskPanel.tsx:192` | DecisionButton (official Button + Spinner) | shadcn Button + Spinner | TaskPanel | #259 | migrated | — |
| Overview/Results/Activity tabs with review count badge | `src/kubecode/tasks/TaskPanel.tsx:197-212` | official Tabs + StatusBadge (Badge variants; ToneBadge removed in #255) | shadcn Tabs, Badge | TaskPanel | #259 | migrated | — |
| Archive blocked / archive confirm dialogs | `src/kubecode/tasks/TaskPanel.tsx:218-243` | official Dialog + Button | shadcn AlertDialog (not installed) | TaskPanel | #259 | partial | Dialog is official; AlertDialog to be added by the slice |
| TaskStatusBadges + condition reason text | `src/kubecode/tasks/TaskStatusBadges.tsx:34-50` | StatusBadge (official Badge); reason is handcrafted span | shadcn Badge | TaskPanel, TaskCardView | #259 | partial | — |
| Waiting-on items list | `src/kubecode/tasks/TaskWork.tsx:87-94` | AI Elements Task/TaskContent/TaskItem | AI Elements Task | TaskWork | #259 | migrated | — |
| Delivery issue rows with Retry and refusal | `src/kubecode/tasks/TaskWork.tsx:39-57,125-127` | handcrafted ul/li + Button | shadcn Item/ItemGroup + Alert | TaskWork | #259 | partial | — |
| Embedded ExecutionStrip scoped to task | `src/kubecode/tasks/TaskWork.tsx:123` | see ExecutionStrip | AI Elements Queue | TaskWork | #259 | partial | — |
| Waiting-on-you section, brief Discuss | `src/kubecode/tasks/TaskOverview.tsx:62-80` | handcrafted section/p + Button | shadcn Alert or Item with ItemActions | TaskOverview | #259 | partial | — |
| Goal / brief summary dl in Plan; Edit brief; notice | `src/kubecode/tasks/TaskOverview.tsx:86-150` | Plan/PlanContent wrapping handcrafted dl; notice p | AI Elements Plan; Alert for notice | TaskOverview | #259 | partial | — |
| Provenance quote | `src/kubecode/tasks/TaskOverview.tsx:163-169` | handcrafted p/q | Item or InlineCitation | TaskOverview | #259 | handcrafted | — |
| People list and empty text | `src/kubecode/tasks/TaskOverview.tsx:190-197` | handcrafted ul + MemberIdentity (official Avatar) | shadcn Item/ItemGroup + Avatar; Empty | TaskOverview | #259 | partial | — |
| Progress work items with stage badges | `src/kubecode/tasks/TaskOverview.tsx:217-233` | AI Elements Task/TaskItem + StatusBadge | AI Elements Task | TaskOverview | #259 | migrated | — |
| Questions list with options and free answer | `src/kubecode/tasks/TaskQuestions.tsx:26-91` | handcrafted ul/li/label + Button, Textarea; error p | Field + Textarea + Button; Item; Alert; Suggestion | TaskOverview | #259 | partial | — |
| In-General empty activity note | `src/kubecode/tasks/TaskActivity.tsx:139` | handcrafted p | shadcn Empty | TaskActivity | #259 | handcrafted | — |
| Decided status note with Show in General | `src/kubecode/tasks/TaskResults.tsx:74-83` | handcrafted p role=status + Button | shadcn Alert | TaskResults | #259 | partial | — |
| Accepted outcome + evidence sources | `src/kubecode/tasks/TaskResults.tsx:103-122,185-186` | AI Elements Sources + Item + ReferenceChip | AI Elements Sources/Source | TaskResults | #259 | migrated | — |
| No results yet empty state | `src/kubecode/tasks/TaskResults.tsx:122` | handcrafted muted p | shadcn Empty | TaskResults | #259 | handcrafted | — |
| Review history list / ReviewSummary | `src/kubecode/tasks/TaskResults.tsx:144-173` | handcrafted ul/li/div + StatusBadge + Button | shadcn Item/ItemGroup + Badge | TaskResults | #259 | partial | — |
| Review form removed-ack checkbox | `src/kubecode/tasks/TaskResults.tsx:359-361` | native checkbox in label | shadcn Checkbox + Field (not installed) | TaskResults | #259 | handcrafted | — |
| Outcome radio fieldset | `src/kubecode/tasks/TaskResults.tsx:366-367,441-446` | native fieldset/legend/radio | shadcn RadioGroup + FieldSet (not installed) | TaskResults | #259 | handcrafted | — |
| Feedback textarea + hint + error | `src/kubecode/tasks/TaskResults.tsx:379-389` | handcrafted label/small + Textarea; error p | Field/FieldLabel/FieldDescription/FieldError + Textarea | TaskResults | #259 | partial | — |
| Accept / request changes decision bar | `src/kubecode/tasks/TaskResults.tsx:398-399` | AI Elements Confirmation + DecisionButton | AI Elements Confirmation | TaskResults | #259 | migrated | — |
| Evidence row version check with Open | `src/kubecode/tasks/TaskResults.tsx:467-477` | official Item/ItemActions + Button | shadcn Item | TaskResults | #259 | migrated | — |
| Activity timeline (empty, steps, Show in General) | `src/kubecode/tasks/TaskActivity.tsx:40-52` | handcrafted ol/li/q + Button; empty p | ChainOfThought steps or Item list; Empty | TaskActivity | #259 | handcrafted | — |
| Recent in General: loading/error/empty/list | `src/kubecode/tasks/TaskActivity.tsx:129-147` | handcrafted p states + Button list | Skeleton/Spinner, Alert, Empty, Item | TaskActivity | #259 | partial | — |
| Execution records / linked records disclosures | `src/kubecode/tasks/TaskActivity.tsx:175-183,228-242` | native details/summary | shadcn Collapsible or Accordion | TaskActivity | #259 | handcrafted | — |
| Imports and ResearchExportPanel inside records | `src/kubecode/tasks/TaskActivity.tsx:242,270` | delegated to research components | n/a here | TaskActivity | #258/#262 | not-applicable | — |

## Kanban

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Needs-you-only switch | `src/kubecode/tasks/TaskBoardView.tsx:118-120` | official Switch + handcrafted span label | shadcn Switch + Field horizontal | TaskBoardView | #259 | partial | — |
| Error/loading states | `src/kubecode/tasks/TaskBoardView.tsx:127-133` | handcrafted p role=alert/status + Button | Alert; Skeleton/Spinner | TaskBoardView | #259 | handcrafted | — |
| Board empty state with Open General | `src/kubecode/tasks/TaskBoardView.tsx:136-140` | official Empty + Button | shadcn Empty | TaskBoardView | #259 | migrated | — |
| Drafts collapsible with draft rows | `src/kubecode/tasks/TaskBoardView.tsx:152-167` | official Collapsible; native button rows + StatusBadge | Collapsible + Item asChild / Button | TaskBoardView | #259 | partial | — |
| Nothing needs you note | `src/kubecode/tasks/TaskBoardView.tsx:175` | handcrafted muted p | shadcn Empty | TaskBoardView | #259 | handcrafted | — |
| Stage tabs (phone) / columns with count + column empty | `src/kubecode/tasks/TaskBoardView.tsx:179-213` | official Tabs; handcrafted column ul + StatusBadge; empty p | Tabs; no Kanban in core registry | TaskBoardView | #259 | partial | No shadcn/ui or AI Elements kanban component exists; column layout is CSS |
| Task card | `src/kubecode/tasks/TaskCardView.tsx:42-66` | official Card wrapping native button + TaskStatusBadges + MemberAvatar | shadcn Card composition + Avatar/AvatarGroup | TaskBoardView | #259 | partial | — |
| Archived collapsible rows | `src/kubecode/tasks/TaskBoardView.tsx:233-254` | official Collapsible; native button rows | Collapsible + Item | TaskBoardView | #259 | partial | — |

## Needs you

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Destination header + manager decisions list | `src/kubecode/attention/NeedsYouView.tsx:44-96` | official ItemGroup/Item + StatusBadge; DestinationHeader | shadcn Item | Needs you route | #259 | migrated | — |
| Decision/setup rows | `src/kubecode/attention/NeedsYouList.tsx:36-61` | official Item wrapping native button with spans | Item asChild with ItemContent/ItemTitle/ItemDescription | Needs you, bell | #259 | partial | — |
| Loading / empty / load-error / Show all | `src/kubecode/attention/NeedsYouList.tsx:91-107` | loading & warn handcrafted p; Empty official | Skeleton, Empty, Alert | Needs you | #259 | partial | — |

## Execution feedback

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Permission prompt | `src/kubecode/attention/PermissionPrompt.tsx:65-104; PromptDecision.tsx` | AI Elements Confirmation; status notes handcrafted p | AI Elements Confirmation (+ Alert) | General, SessionComposer | #259 | migrated | — |
| Elicitation prompt form fields | `src/kubecode/attention/ElicitationPrompt.tsx:66-137` | Confirmation + Field/Input/Switch/Select | AI Elements Confirmation + shadcn Field | General, SessionComposer | #259 | migrated | — |
| Execution strip: summary trigger, popover, Queue, failed row + Dismiss | `src/kubecode/attention/ExecutionStrip.tsx:122-134,243-307` | official Popover, Queue/QueueSection/Shimmer; failed row handcrafted li; lucide chevron since #255 | AI Elements Queue, Shimmer; Popover; Alert | General, TaskWork | #259 | partial | — |
| ExecutionRow (who, queued, state, stop) | `src/kubecode/attention/ExecutionRow.tsx:40-59` | QueueItem + Item + Shimmer + MemberIdentity + StopButton | AI Elements Queue + Item | ExecutionStrip | #259 | migrated | — |
| Round pause control + notice | `src/kubecode/attention/RoundPauseControl.tsx:46-53` | PauseButton (official Button outline/secondary); notice handcrafted p | shadcn Button/Toggle; Alert | TaskWork | #259 | partial | — |

## Research questions

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Research linked threads panel + empty state | `src/kubecode/research/ResearchThreadsPanel.tsx:36-55` | handcrafted section/ul/p with Button | shadcn Item + Empty | ResearchWorkspace, TaskActivity | #262 | handcrafted | — |

## Members

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| View shell + Current/Defaults tabs | `src/kubecode/members/MembersView.tsx:69-91` | official Tabs in handcrafted section | shadcn/ui Tabs | members route | #260 | migrated | — |
| Roster header (h3 + description + Add member) | `src/kubecode/members/MemberRoster.tsx:294-303` | handcrafted header/h3 + Button | Item header or Card CardHeader/CardAction | MembersView | #260 | partial | — |
| Member list rows | `src/kubecode/members/MemberRoster.tsx:310-400` | official Item in handcrafted ul; StatusBadge and IconButton | ItemGroup + Item, Badge, Button + Tooltip | MembersView | #260 | partial | — |
| Row actions: restart/replace provider, profile, DM | `src/kubecode/members/MemberRoster.tsx:355-400` | IconButton (official Button + Tooltip) | shadcn Button + Tooltip | MemberRoster | #260 | migrated | IconButton is the A-owned thin wrapper |
| Load error state with Retry | `src/kubecode/members/MemberRoster.tsx:158-162` | handcrafted text + Button | shadcn Alert or Empty | MemberRoster | #260 | partial | — |
| Add/edit member form | `src/kubecode/members/MemberRoster.tsx:170-255` | official Field, Input, Select, Textarea, Button; lock note span | shadcn Field, FieldGroup | MemberRoster | #260 | migrated | — |
| Replace provider inline form | `src/kubecode/members/MemberRoster.tsx:270-290` | official Field + ProviderSelect + Button | shadcn Field + Select + Button | MemberRoster | #260 | migrated | — |
| ProviderSelect | `src/kubecode/members/ProviderSelect.tsx:22-33` | official Select | shadcn Select | MemberRoster, MemberDefaultsPanel | #260 | migrated | — |
| Defaults panel header + unsaved badge | `src/kubecode/members/MemberDefaultsPanel.tsx:122-129` | handcrafted header/h3 + StatusBadge | Card header or Item; Badge | MembersView, SettingsDialog | #260 | partial | — |
| Defaults fields, key/value rows, template FieldSet, Save/Discard | `src/kubecode/members/MemberDefaultsPanel.tsx:137-225` | official Field/FieldSet, Input, Textarea, Button; handcrafted row layout | FieldSet/FieldGroup, InputGroup, Button | MembersView, SettingsDialog | #260 | partial | — |
| MemberPanel inspector content | `src/kubecode/members/MemberPanel.tsx:36-100` | InspectorPanel + Field/FieldTitle, Button, StatusBadge; handcrafted sections | Field horizontal, Collapsible, Badge | inspector registry | #260 | partial | — |
| ManagerSetupNotice | `src/kubecode/members/ManagerSetupNotice.tsx:56-75` | official Alert + Button (CSS redraw listed in the CSS baseline) | shadcn Alert | General | #260 | migrated | — |

## Workspace setup

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ProjectDialog: mode switch, PathPicker, hidden toggle, error, loading/empty | `src/kubecode/app/ProjectDialog.tsx:153-200; src/kubecode/PathPicker.tsx:97-125` | official Dialog + Buttons; handcrafted mode switch, path list, error div | Dialog, ToggleGroup, Command, Alert, Toggle | WorkbenchShell, navigator, first run | #260 | partial | — |

## Settings

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SettingsDialog shell + section nav | `src/kubecode/app/SettingsDialog.tsx:174-191` | official Dialog; handcrafted aside nav of Buttons | Dialog + Tabs vertical / Sidebar | WorkbenchShell | #260 | partial | — |
| General rows: color scheme, theme, fonts, size | `src/kubecode/app/SettingsDialog.tsx:192-285` | official Select/Input in handcrafted setting rows | Field orientation=horizontal | SettingsDialog | #260 | partial | — |
| Language switch | none (locale from browser) | not present | shadcn Select if added | n/a | #260 | not-applicable | No language selector component in src/kubecode at origin/main |
| Notifications rows | `src/kubecode/app/SettingsDialog.tsx:286-377` | official Select/Switch/Button in handcrafted rows | Field horizontal + Switch/Select | SettingsDialog | #260 | partial | — |
| Agents: teammate chat Switch; readiness toolbar | `src/kubecode/app/SettingsDialog.tsx:378-417` | official Switch/Button in handcrafted rows | Field horizontal, Button | SettingsDialog | #260 | partial | — |
| Agents: per-agent diagnostic details + rows | `src/kubecode/app/SettingsDialog.tsx:420-457,606-628` | native details/summary + custom rows | Collapsible/Accordion + Item | SettingsDialog | #260 | handcrafted | — |
| RuntimeStatusPanel | `src/kubecode/app/SettingsDialog.tsx:542-604` | handcrafted status spans + dl; Button | Spinner/Skeleton, Alert, Item/Card | SettingsDialog | #260 | handcrafted | — |
| Member defaults row + panel | `src/kubecode/app/SettingsDialog.tsx:465-480` | handcrafted row + Button + panel | Field horizontal | SettingsDialog | #260 | partial | — |
| WeChat panel: status, connect, QR, verification, binding messages | `src/kubecode/app/WeChatSettingsPanel.tsx:200-345,410-420` | official Button/Input; handcrafted rows, figure, label, status spans | Field, Alert, Spinner, InputOTP (not installed) | SettingsDialog | #260 | partial | — |
| WeChat disconnect confirm | `src/kubecode/app/WeChatSettingsPanel.tsx:360-375` | official Dialog | shadcn AlertDialog (not installed) | WeChatSettingsPanel | #260 | partial | — |
| WeChat active session Select | `src/kubecode/app/WeChatSettingsPanel.tsx:433-450` | official Select | shadcn Select | WeChatSettingsPanel | #260 | migrated | — |
| QuickPromptsEditor | `src/kubecode/app/WeChatSettingsPanel.tsx:500-574` | official Textarea/Button in handcrafted rows; error span | Field + Textarea + Alert | WeChatSettingsPanel | #260 | partial | — |
| Editor auto save Switch row | `src/kubecode/app/SettingsDialog.tsx:492-511` | official Switch in handcrafted row | Field horizontal + Switch | SettingsDialog | #260 | partial | — |
| Terminal coming-soon placeholder | `src/kubecode/app/SettingsDialog.tsx:513-515` | handcrafted div | shadcn Empty | SettingsDialog | #260 | handcrafted | — |
| DisableWorkspacesDialog | `src/kubecode/DisableWorkspacesDialog.tsx:100-110` | official Dialog | shadcn AlertDialog | WorkbenchShell | #260 | partial | — |

## Session

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Message turn (bubble, copy/edit/retry/branch) | `src/components/AiMessage.tsx:11-31,446` | AI Elements Message + Collapsible/Badge/Button | AI Elements Message | Session timeline | #261 | migrated | — |
| User prompt inline editor | `src/components/AiMessage.tsx:131-160` | official Textarea/Button in handcrafted wrapper | Textarea + Button (or PromptInput) | AiMessage | #261 | partial | — |
| Reasoning block | `src/components/AiMessage.tsx:17-21,222` | AI Elements Reasoning + Shimmer | AI Elements Reasoning | AiMessage | #261 | migrated | — |
| Tool-use group header / segments / working indicator | `src/components/AiMessage.tsx:262,387,410` | handcrafted div/span + Spinner/Shimmer | AI Elements Tool / Shimmer, Spinner | AiMessage | #261 | partial | — |
| Markdown rendering | `src/kubecode/session/SessionMarkdown.tsx` | MessageResponse (Streamdown) | AI Elements MessageResponse | AiMessage | #261 | migrated | — |
| Tool action card | `src/components/AiActionCard.tsx:3-10` | AI Elements Tool + CodeBlock | AI Elements Tool, CodeBlock | AiMessage | #261 | migrated | — |
| Conversation scroller + scroll-to-bottom | `src/components/AiPanelChrome.tsx:9,487,552` | specialist engine react-virtuoso + handcrafted ArrowDown Button | AI Elements Conversation/ConversationScrollButton | SessionTimeline | #261 | specialist-engine | Virtualization of long transcripts; Conversation does not virtualize. Scroll button could use ConversationScrollButton |
| Panel header / linked-context strip / empty hint | `src/components/AiPanelChrome.tsx:342-348,384,462-464` | handcrafted divs with inline styles | Item / Empty / Badge | AI panel | #261 | handcrafted | — |
| Prompt input (body, tools, submit, stop) | `src/components/AiPanelChrome.tsx:10-19,626-740` | PromptInputBody/Tools/Submit + InputGroup; custom WikilinkChatInput; StopButton | AI Elements PromptInput/PromptInputTextarea | SessionComposer | #261 | partial | WikilinkChatInput is a contenteditable mention engine (specialist) |
| Composer status/error lines | `src/components/AiPanelChrome.tsx:711-716` | handcrafted span | Field description / Alert | AiPanelComposer | #261 | handcrafted | — |
| Composer wrapper, read-only revision banner, leader-review dock | `src/kubecode/session/SessionComposer.tsx:169-198` | handcrafted divs | Alert / Confirmation | SessionWorkspace | #261 | handcrafted | — |
| Mode/model/config control menu | `src/kubecode/AgentControlMenu.tsx:102-200` | handcrafted popover role=dialog/menu | DropdownMenu (RadioGroup, Sub) or PromptInputSelect/ModelSelector | SessionComposer | #261 | handcrafted | — |
| Slash command suggestions | `src/kubecode/AcpCommandMenu.tsx:23-42` | handcrafted listbox with Buttons | shadcn Command | SessionComposer | #261 | handcrafted | — |
| Side question panel | `src/kubecode/SideQuestionPanel.tsx:22-88` | handcrafted collapsible header + list + Button | Collapsible / AI Elements Queue / Item | SessionComposer | #261 | handcrafted | Listed under #261 and #262 in the source inventory; #261 owns the Session composer |
| System message notice | `src/kubecode/SystemMessageNotice.tsx:58-118` | handcrafted div role=status/alert + Button | shadcn Alert | SessionComposer | #261 | handcrafted | — |
| Plan summary | `src/kubecode/session/SessionPlanSummary.tsx:4-35` | AI Elements Plan + small heading div | AI Elements Plan | SessionComposer | #261 | migrated | — |
| Prompt queue dock | `src/kubecode/session/PromptQueueDock.tsx:4-18,75` | AI Elements Queue + Input/Button | AI Elements Queue | SessionWorkspace | #261 | migrated | — |
| Usage/context meter | `src/kubecode/session/UsageMeter.tsx:4-13,77` | AI Elements Context + Progress | AI Elements Context | SessionTitlebar | #261 | migrated | — |
| Title, status dot, team view switch, overflow menu | `src/kubecode/session/SessionTitlebar.tsx:5-11,58-92` | DropdownMenu; handcrafted tablist and status dot | Tabs/ToggleGroup, Badge | SessionWorkspace | #261 | partial | — |
| Subagent bubble | `src/kubecode/session/SubagentBubble.tsx:4-11,54` | AI Elements Task + Shimmer + Badge | AI Elements Task | SessionTimeline | #261 | migrated | — |
| Timeline wrapper, recreated-context divider | `src/kubecode/session/SessionTimeline.tsx:53,78` | handcrafted div | Separator / AI Elements Checkpoint | SessionWorkspace | #261 | handcrafted | — |
| Revision navigator | `src/kubecode/session/RevisionNavigator.tsx:20-30` | handcrafted div + Buttons | ButtonGroup / MessageBranch | SessionWorkspace | #261 | partial | — |
| Empty state: agent readiness grid, start actions | `src/kubecode/session/SessionWorkspace.tsx:475-533` | handcrafted section/grid + Buttons | Empty + Item/Card | session route | #261 | handcrafted | — |
| Rename/fork dialogs and header | `src/kubecode/session/SessionWorkspace.tsx:7-16,632` | official Dialog + Input; header handcrafted | shadcn Dialog | SessionWorkspace | #261 | migrated | — |

## Team

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Delete team dialog | `src/kubecode/DeleteTeamDialog.tsx:3-12` | official Dialog | Dialog (or AlertDialog) | SessionWorkspace | #261 | migrated | — |
| Team workspace view + proposal dialog | `src/kubecode/TeamWorkspaceView.tsx:4-21,85` | official Dialog/Button | shadcn Dialog | SessionWorkspace | #261 | migrated | — |
| Team member overview tree | `src/kubecode/TeamSessionOverview.tsx:26-65` | handcrafted tree divs + Button | Item / Sidebar menu / Avatar | SessionWorkspace | #261 | handcrafted | — |
| Team setup form (goal, criteria, mode grid, budget) | `src/kubecode/team/TeamSetupView.tsx:114-170` | Textarea/Button official; labels, mode grid, budget handcrafted | Field, RadioGroup/ToggleGroup | TeamWorkspaceView | #261 | partial | — |
| Team leader permission/native options | `src/kubecode/team/TeamPermissionView.tsx:39-68` | Switch official; layout handcrafted | Field + Switch | TeamSetupView | #261 | partial | — |
| Lineup proposal card | `src/kubecode/team/TeamProposalView.tsx:13-61` | handcrafted section + spans, Button | Card + Badge | TeamWorkspaceView | #261 | handcrafted | — |
| Control center header, badges, metrics, needs-attention | `src/kubecode/team/TeamStatusView.tsx:74-224` | handcrafted header/badges/tiles; Textarea/Button | Badge, Card, Item, Alert | TeamWorkspaceView | #261 | partial | — |
| Tasks tabs, activity, dependencies, detail dialog, status select | `src/kubecode/team/TeamTasksView.tsx:11-31,72-234` | official Tabs/Dialog/Select/Button; handcrafted lists and dl | Tabs, Dialog, Select, Item | TeamWorkspaceView | #261 | partial | — |
| Verification rounds list | `src/kubecode/team/TeamVerificationView.tsx:12-17` | handcrafted section/div | Item/Badge or AI Elements Task | TeamWorkspaceView | #261 | handcrafted | — |

## Context workbench

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Explorer/Editor/Diff primary tabs | `src/kubecode/ContextWorkbench.tsx:351-578` | official Tabs + kubecode-context-* CSS | shadcn Tabs | inspector | #262 | migrated | — |
| New file / New folder icon buttons | `src/kubecode/ContextWorkbench.tsx:392-393` | official Button icon-xs | Button + Tooltip (IconButton) | ContextWorkbench | #262 | partial | aria-label only, no Tooltip |
| ExplorerSection collapsible header | `src/kubecode/ContextWorkbench.tsx:670-706` | handcrafted heading toggle | shadcn Collapsible | ContextWorkbench | #262 | handcrafted | — |

## Git

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Create repository / no changes empty states | `src/kubecode/ContextWorkbench.tsx:409-419` | handcrafted kubecode-review-empty divs | shadcn Empty | ContextWorkbench | #262 | handcrafted | — |
| Git notices (conflict/status) | `src/kubecode/ContextWorkbench.tsx:423,438` | handcrafted div role=status | shadcn Alert | ContextWorkbench | #262 | handcrafted | — |
| Change groups and rows with stage/unstage/discard | `src/kubecode/ContextWorkbench.tsx:708-832` | handcrafted list + Button | Item/ItemGroup + Button + Tooltip (+ Collapsible) | ContextWorkbench | #262 | partial | — |
| Commit box | `src/kubecode/ContextWorkbench.tsx:471-474` | official Input + Button in div | InputGroup or Field + Button | ContextWorkbench | #262 | partial | — |
| Discard changes confirmation | `src/kubecode/ContextWorkbench.tsx:626-668` | official Dialog | shadcn AlertDialog (not installed) | ContextWorkbench | #262 | partial | — |

## Plan panel

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent plan list with status icons | `src/kubecode/ContextWorkbench.tsx:484-505` | handcrafted ol | AI Elements Plan or Queue | ContextWorkbench | #262 | handcrafted | — |

## File tree

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Project file tree (ARIA tree, keyboard nav) | `src/kubecode/ProjectFileTree.tsx:57-448` | handcrafted ARIA tree with Button in parts | AI Elements File Tree (not installed) | ContextWorkbench | #262 | handcrafted | — |
| Loading/empty/error message | `src/kubecode/ProjectFileTree.tsx:403` | handcrafted div role=status | Empty / Spinner / Alert | ContextWorkbench | #262 | handcrafted | — |

## File dialogs

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| New file/folder EntryDialog | `src/kubecode/ContextWorkbench.tsx:870-1000,588-595` | official Dialog + Input | Dialog + Field | ContextWorkbench | #262 | partial | — |
| Quick open with ProjectFilePicker/PathPicker | `src/kubecode/ContextWorkbench.tsx:600-624; src/kubecode/ProjectFilePicker.tsx:29` | official Dialog wrapping handcrafted combobox/listbox | CommandDialog/Command | ContextWorkbench, ComposerAddMenu, ProjectDialog | #262 | partial | — |

## Editor

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Editor toolbar (path, unsaved, save, close) | `src/kubecode/ContextWorkbench.tsx:539-552` | handcrafted toolbar + Button | ButtonGroup + Badge + Tooltip | ContextWorkbench | #262 | partial | — |
| CodeMirror editor | `src/kubecode/CodeEditor.tsx:1-93` | specialist engine (CodeMirror 6) | none (CodeBlock is read-only) | ContextWorkbench | #262 | specialist-engine | Editable code has no shadcn/AI Elements equivalent |

## Diff

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Git diff viewer states and content | `src/kubecode/GitDiffView.tsx:30-50` | handcrafted pre + status/alert divs | AI Elements CodeBlock (diff) + Empty/Alert/Spinner | ContextWorkbench | #262 | handcrafted | — |

## Terminal

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xterm terminal view | `src/kubecode/TerminalView.tsx:1-171` | specialist engine (@xterm/xterm) | none (AI Elements Terminal is output-only) | terminal | #262 | specialist-engine | Interactive PTY requires xterm |
| Terminal navigator tree | `src/kubecode/TerminalWorkspace.tsx:440-588` | handcrafted ARIA tree | Sidebar menu / Item | terminal | #262 | handcrafted | — |
| Inline rename editor | `src/kubecode/TerminalWorkspace.tsx:590-626` | official Input | shadcn Input | terminal | #262 | migrated | — |
| New terminal profile menu | `src/kubecode/TerminalWorkspace.tsx:628-663` | official DropdownMenu | shadcn DropdownMenu | terminal | #262 | migrated | — |
| Split layout and resize handles | `src/kubecode/TerminalWorkspace.tsx:666-771; src/components/ResizeHandle.tsx` | handcrafted layout + ResizeHandle | shadcn Resizable (not installed) | terminal | #262 | handcrafted | Follows the Resizable ADR written by #256 |

## Research

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Research navigator list | `src/kubecode/research/ResearchNavigator.tsx:34-80` | handcrafted ul with raw button + StatusBadge | Sidebar menu / Item + Badge | history | #262 | handcrafted | — |
| Workspace header, tabs, loading/error, notices | `src/kubecode/research/ResearchWorkspace.tsx:127-272` | official Tabs; handcrafted header, notices, link button | Tabs + Alert + Empty + Button link | research route | #262 | partial | — |
| New research dialog | `src/kubecode/research/NewResearchDialog.tsx:68-103` | official Dialog + Input + Textarea | Dialog + Field | research route | #262 | partial | error p not Field/FieldError |
| Brief form and fields | `src/kubecode/research/ResearchBriefPanel.tsx:133-211` | handcrafted form + Input/Textarea/Button | Field/FieldGroup + Alert | research route | #262 | partial | — |
| Discussion panel (sessions, Select, Textarea, log, errors) | `src/kubecode/research/ResearchDiscussionPanel.tsx:113-250` | official Select/Textarea/Button in handcrafted lists | Item, Field, Empty, Alert; Conversation for log | research route | #262 | partial | Listed under #259 and #262 in the source inventory; #262 owns research views |
| Findings, suggested changes, pending outcomes, capture form | `src/kubecode/research/ResearchFindingsPanel.tsx:3-12,63-330` | handcrafted cards/lists + DecisionButton + StatusBadge; Input/Textarea; error p | Card/Item + Badge + Field + Alert; Sources/InlineCitation | research route | #262 | partial | Finding sources lists are #258 (references) |
| Rounds panel and start-round form | `src/kubecode/research/ResearchRoundsPanel.tsx:164-407` | handcrafted form with raw inputs | Checkbox/RadioGroup (not installed) + Field + Card | research route | #262 | handcrafted | — |
| Import panel | `src/kubecode/research/ResearchImportPanel.tsx:98-430` | handcrafted with raw checkboxes + Input/Textarea/Button | Field + Checkbox + Alert; CodeBlock | research route, TaskActivity | #262 | partial | — |
| Export panel | `src/kubecode/research/ResearchExportPanel.tsx:81-155` | handcrafted raw inputs + Textarea/Button | Checkbox/RadioGroup + Alert + CodeBlock | research route, TaskActivity | #262 | partial | — |
| AvailabilityBadge / StaleBadge | `src/kubecode/research/SourceBadge.tsx:11-29` | StatusBadge | shadcn Badge | research route | #255 | migrated | Became the official Badge through StatusBadge in #255 |

## Experiment runner

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Execution section, envelope, attention, cards, logs | `src/kubecode/research/ResearchExecutionSection.tsx:121-650` | handcrafted cards/lists/pre + Input/Button + StatusBadge | Card + Badge + Alert; Task/Tool, CodeBlock/Terminal | research route | #262 | partial | — |
| Cancel/reconcile confirmation | `src/kubecode/research/ResearchExecutionSection.tsx:545,656-672` | handcrafted inline alertdialog | AlertDialog or AI Elements Confirmation | research route | #262 | handcrafted | — |
| Execution envelope fields | `src/kubecode/research/ExecutionEnvelopeFields.tsx:1-79` | official Input/Textarea, handcrafted error | Field/FieldError | research route | #262 | partial | — |

## Shared primitive

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| StatusBadge | `src/components/workspace/StatusBadge.tsx` | official Badge; tone → success/info/warning/destructive/secondary variant | shadcn Badge | 24 consumers | #255 | migrated | ToneBadge (duplicate) removed |
| IconButton | `src/components/workspace/IconButton.tsx:40` | official Button size=icon + ActionTooltip on Tooltip | shadcn Button + Tooltip | app-wide (8) | #255 | migrated | — |
| ActionTooltip + actionTooltipRecovery | `src/components/ui/action-tooltip.tsx; src/components/ui/actionTooltipRecovery.ts` | thin wrapper over official Tooltip with focus/touch recovery | shadcn Tooltip | IconButton, SendButton | #255 | partial | Recovery handles Radix tooltip re-open after a menu closes; kept as the smallest adapter, see ADR 0247 |
| MoreActions | `src/components/workspace/MoreActions.tsx:36` | official DropdownMenu + IconButton | shadcn DropdownMenu | headers, messages, tasks | #255 | migrated | — |
| DecisionButton | `src/components/workspace/DecisionButton.tsx` | official Button variants + official Spinner | Button / ConfirmationAction | 4 consumers | #255 | migrated | — |
| SendButton / StopButton / PauseButton | `src/components/workspace/SendButton.tsx` | official Button default/outline/secondary variants + official Spinner; no colour redraw | AI Elements PromptInputSubmit inside composers | AiPanelChrome, ExecutionRow, RoundPauseControl | #255 | migrated | Composers use PromptInputSubmit (#257, #261); these name a scoped run |
| ReferenceChip | `src/components/workspace/ReferenceChip.tsx` | official Badge (outline) + Button (ghost) open/remove | Badge / InlineCitation; Attachment | 8 consumers | #255 | migrated | — |
| MemberIdentity / MemberAvatar | `src/components/workspace/MemberIdentity.tsx` | official Avatar/AvatarFallback, link Button, Badge | shadcn Avatar + Badge | 6 consumers | #255 | migrated | — |
| ViewHeader | `src/components/workspace/ViewHeader.tsx:49-72` | header composition over tokens + IconButton | no registry page header; compose Item/Separator | DestinationHeader, InspectorPanel | #255 | exception | No shadcn page-header component exists; kept as a thin composition over tokens |
| Attachment | `src/components/ui/attachment.tsx:1-204` | local component in ui/ | AI Elements PromptInput attachments | 1 consumer | #255 | partial | #258 decision (ADR 0248 §5): ReferenceChip composes this Attachment; Prompt Input attachments are for uploaded files, which Kubecode has no service for |

## Config

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| components.json iconLibrary vs icon imports | `components.json; src/components/ui/{dialog,select,dropdown-menu}.tsx; ExecutionStrip.tsx` | lucide everywhere; @phosphor-icons/react removed | single iconLibrary (lucide) | all | #255 | migrated | — |

## Shared CSS

| Element | Files | Current | Official replacement | Consumers | Owner | Status | Exception / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tokens: legacy --surface-*/--text-*/--accent-* vs shadcn variables | `src/index.css; src/kubecode/kubecode.css` | one semantic layer on :root and [data-theme]; data-ws-components scoping removed | shadcn CSS variables only | all, including portals | #255 | migrated | Legacy primitives stay as the brand palette the layer maps from |
| Global overrides of Button/Input/SelectTrigger font-size and icon svg size | `src/kubecode/kubecode.css (former 84-90, 2270-2273)` | removed | Button size variants | every Button | #255 | migrated | — |
| !important overrides | `src/kubecode/kubecode.css` | listed in scripts/css-ownership-baseline.json with owners | component variants/className | various pages | #255 with #257-#262 | partial | xterm viewport and prefers-reduced-motion are specialist/accessibility exceptions |
| Per-page data-slot overrides (Tabs, Dialog, Select, Item, Field, Avatar, Progress, Alert, Empty, Plan, InputGroup) | `src/kubecode/kubecode.css` | listed in scripts/css-ownership-baseline.json with owners; pnpm lint blocks new ones | variants/className; remove slot redraws | Team, settings, tasks, needs-you, members, composer, conversation | #256-#262 | partial | — |
| Area redraw selectors (ws-search, reference, record-preview, evidence, research, attach) | `src/kubecode/kubecode.css` | CSS redraw; ReferenceChip redraw removed in #255 | semantic tokens on official components | resources, research | #262 | partial | #258 removed ws-search, reference, record-preview, evidence and attach rules; research remains #262 |

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
