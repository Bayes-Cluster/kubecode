# UI G (#261) acceptance evidence

Evidence for [ADR 0253](../adr/0253-session-and-team-execution-views-on-official-components.md)
and the #261 rows of [ui-migration-inventory.md](ui-migration-inventory.md).

## Screenshots

Captured with Playwright against the real standalone server (smoke fixture
Project, OpenCode smoke Agent) built from `main` (before) and from this branch
(after). German is the long-copy locale. The Chat/Team switch in the title bar
moved from Tabs to a single ToggleGroup after capture (a view switch has no tab
panels); its look matches the New Session dialog's mode switch.

| Surface | Before | After |
| --- | --- | --- |
| Session, de-DE, light, 1440 | `before-session-de-light-1440.png` | `after-session-de-light-1440.png` |
| Session, de-DE, light, 768 | `before-session-de-light-768.png` | `after-session-de-light-768.png` |
| Session, de-DE, light, 390 | `before-session-de-light-390.png` | `after-session-de-light-390.png` |
| Session, de-DE, light, 320 | `before-session-de-light-320.png` | `after-session-de-light-320.png` |
| Session, de-DE, dark, 1440 | `before-session-de-dark-1440.png` | `after-session-de-dark-1440.png` |
| Session, de-DE, dark, 768 | `before-session-de-dark-768.png` | `after-session-de-dark-768.png` |
| Session, de-DE, dark, 390 | `before-session-de-dark-390.png` | `after-session-de-dark-390.png` |
| Session, de-DE, dark, 320 | `before-session-de-dark-320.png` | `after-session-de-dark-320.png` |
| Session, en, light, 1440 | `before-session-en-light-1440.png` | `after-session-en-light-1440.png` |
| Team setup, de-DE, light, 1440 | `before-team-setup-de-light-1440.png` | `after-team-setup-de-light-1440.png` |
| Team setup, de-DE, light, 390 | `before-team-setup-de-light-390.png` | `after-team-setup-de-light-390.png` |
| Team setup, de-DE, dark, 1440 | `before-team-setup-de-dark-1440.png` | `after-team-setup-de-dark-1440.png` |
| Team setup, de-DE, dark, 390 | `before-team-setup-de-dark-390.png` | `after-team-setup-de-dark-390.png` |
| Agent control menu by keyboard | `before-keyboard-agent-menu-en-1440.png` | `after-keyboard-agent-menu-en-1440.png` |
| Agent control menu by touch, 390 | `before-touch-agent-menu-en-390.png` | `after-touch-agent-menu-en-390.png` |
| Slash command suggestions | `before-slash-commands-en-1440.png` | `after-slash-commands-en-1440.png` |
| IME composing (ja) | `before-ime-composing-ja-1440.png` | `after-ime-composing-ja-1440.png` |
| IME committed (ja) | `before-ime-committed-ja-1440.png` | `after-ime-committed-ja-1440.png` |
| Zoom 200% + reduced motion | `before-zoom200-reduced-motion-en-1440.png` | `after-zoom200-reduced-motion-en-1440.png` |

## Official source comparison

Each migrated surface renders the unmodified registry component; kubecode.css
keeps only layout rules for it (contract §3), checked by
`scripts/css-ownership-baseline.json`.

| Surface | Official source |
| --- | --- |
| Transcript turns, reasoning, tools, plan, queue, context meter, subagent, checkpoint | AI Elements (elements.ai-sdk.dev): Message, Reasoning, Tool, Plan, Queue, Context, Task, Checkpoint |
| Composer | AI Elements PromptInput (contenteditable mention input stays specialist) |
| Agent control menu | shadcn DropdownMenu (Sub, RadioGroup, CheckboxItem) |
| Slash commands | shadcn Command |
| Notices, read-only banner, leader review | shadcn Alert |
| Revision navigator | shadcn ButtonGroup |
| Empty state, team members, metrics, task lists | shadcn Empty, Item |
| Team setup, permissions, work forms | shadcn Field, RadioGroup, ToggleGroup, Select, Switch, Input, Textarea |
| Chat/Team switch | shadcn ToggleGroup |
| Proposal | shadcn Card + Badge |

## Performance

`AiPanelMessageHistory` under jsdom (Vitest), median of five runs per
measurement: initial render of a 90-turn history, 60 streamed chunks into the
last turn, and three 30-turn Sessions streaming 40 chunks at once. Times in ms;
`main` at bd45ff1 against this branch, run alternately on the same machine.

| Run | initial90 main / G | stream60 main / G | concurrent3x40 main / G |
| --- | --- | --- | --- |
| 1 | 1635 / 1642 | 9995 / 10490 | 6874 / 7194 |
| 2 | 1566 / 1433 | 8835 / 8900 | 6091 / 6366 |
| 3 | 1551 / 1604 | 9409 / 9114 | 6839 / 6458 |
| 4 (machine under load) | 2464 / 2812 | 19395 / 21394 | 13674 / 15728 |

On the three unloaded rounds the differences change sign and stay within ±9%
(initial), ±5% (streaming) and ±6% (concurrent), the same spread as `main`
against itself (round-to-round 1–10%). Round 4 ran while the machine was loaded
and doubled both sides, so it is not a comparison. No regression is shown; the
transcript stays virtualized by react-virtuoso, so long histories render the
same number of rows.

## Inventory reconciliation

All 33 original #261 rows are kept: none were deleted, merged or re-owned.
Three rows were added (Work board filters/columns, Work inspector forms, New
Session dialog), giving 36: 34 migrated, Prompt input partial (contenteditable
mention engine), Conversation scroller specialist-engine (react-virtuoso).
Rows that were not migrated before this branch: Panel header / linked-context
strip (deleted as unused, empty hint is Empty), Composer status lines, Composer
wrapper/leader review, Agent control menu, Slash commands, Side question panel,
System message notice, Team member tree, Lineup proposal, Verification rounds,
Timeline wrapper, Empty state (handcrafted); User prompt editor, Tool-use group,
Title bar, Revision navigator, Team setup, Team permissions, Control center,
Team tasks (partial). Each of those is now migrated.
