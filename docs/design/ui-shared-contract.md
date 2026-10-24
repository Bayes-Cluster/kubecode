# UI shared contract (slices A–I, UI2 A–L)

Published by #255 (UI A) for the slices under #254: B #256, C #257, D #258,
E #259, F #260, G #261, H #262, I #263. The decision is
[ADR 0247](../adr/0247-official-components-own-base-appearance.md); the
per-surface status is in [ui-migration-inventory.md](ui-migration-inventory.md).

## 1. Component order of preference

1. An AI Elements component (`src/components/ai-elements/`) when the surface is
   conversational or agent work.
2. A shadcn/ui component (`src/components/ui/`).
3. A shared Workspace wrapper below, when the surface needs its domain or
   accessibility contract.
4. A new adapter only where no registry item fits. Record the search, the
   gap, the smallest adapter and its tests in your slice's ADR and in the
   inventory row (`exception` or `specialist-engine`).

Official components own structure, states, colours, typography, radii,
shadows and internal layout. Choose a `variant`/`size`; pass `className` only
for layout (flex, grid, gap, width, margin, alignment, truncation).

## 2. Pass-throughs (`src/components/workspace/`, owned by A)

Since [ADR 0255](../adr/0255-official-components-own-their-variants-and-the-parallel-layer-is-retired.md)
these are compositions of official parts with no CSS of their own. They
choose variants and carry one contract each; add nothing to them that a
variant could carry.

| Component | Props | Composition |
| --- | --- | --- |
| `IconButton` | `label` (required), `icon`, `shortcut?`, `busy?`, `size?: 'sm' \| 'md'`, Button props | `Button size="icon-xs|icon-sm"` inside `Tooltip`; `Kbd` shortcut; busy is the `Spinner` and keeps focus |
| `MemberAvatar` | `name`, `role`, `size?: 'sm' \| 'md'` | `Avatar` + `AvatarFallback`, `aria-hidden` |
| `MemberIdentity` | `name`, `handle?`, `role`, `roleLabel?`, `attention?`, `activity?`, `meta?`, `onOpen?`, `size?` | `Item size="compact"`: `ItemMedia` (avatar), `ItemTitle` (name; a link `Button size="inline"` when it opens), `ItemDescription` (handle, role, attention `Badge`, activity, details) |
| `ViewHeader` | `title`, `icon?`, `description?`, `meta?`, `actions?`, `back?`, `close?`, `level?` | `Item`: `ItemHeader` (Back, `ItemMedia` glyph, heading in `ItemTitle`, `ItemActions`, Close), `ItemContent` (meta), `ItemDescription`; the `header` element takes only its context's padding |
| `DestinationHeader` | `destination`, `t`, `title?`, `description?`, `meta?`, `actions?` | `ViewHeader` + `Separator` |
| `ReaderLoading` / `ReaderEmpty` / `ReaderNotice` (`src/kubecode/resources/ReaderStates.tsx`) | `children`; `action?`, `failed?`, `live?` | `Empty size="compact"` with the `Spinner` as `EmptyMedia`; `Alert` |
| `ReferenceChip` | `kind`, `kindLabel`, `title`, `version?`, `state?`, `onOpen?`, `onRemove?` + `removeLabel` | `Attachment` parts + `Badge` |
| `MoreActions` | `label`, `items`, `align?` | `DropdownMenu` + `IconButton` |

Retired in #277, with their CSS: `StatusBadge` (use `Badge` with
`statusToneVariant(tone)` from `src/kubecode/statusTone.ts`, or a literal
variant), `DecisionButton`/`PromptDecision` (a `Button` or
`ConfirmationAction` in `size="wrap"`, busy `Spinner`, reason as
`FieldDescription`), `SendButton`/`StopButton`/`PauseButton`
(`PromptInputSubmit`; `Button` + `Tooltip` with a `pointer-fine:sr-only`
label; `Toggle`), `ConversationIdentity` (use `Identity`), `ActionTooltip`
(`Tooltip` + `Kbd`), `SystemMessageNotice` (`toast()` from `sonner` through
`SystemMessageProvider`, or an inline `Alert`).

Do not add a second badge, chip, avatar, button or header wrapper in a
slice. If a part lacks a size or tone, add it to the official file once,
with a line in your slice's ADR.

## 3. Tokens and variants

Declared once in `src/index.css` on `:root` and `[data-theme]`, for light and
dark and every app theme (`data-kubecode-theme`):

`--background`, `--foreground`, `--card(-foreground)`, `--popover(-foreground)`,
`--primary(-foreground)`, `--secondary(-foreground)`, `--muted(-foreground)`,
`--accent(-foreground)`, `--destructive(-foreground)`, `--success(-foreground)`,
`--info(-foreground)`, `--warning(-foreground)`, `--border`, `--input`,
`--ring`, `--radius`, `--chart-1` … `--chart-5`, `--sidebar`,
`--sidebar-foreground`, `--sidebar-primary(-foreground)`,
`--sidebar-accent(-foreground)`, `--sidebar-border`, `--sidebar-ring`.

Use them through Tailwind (`bg-muted`, `text-muted-foreground`,
`border-border`, `bg-success text-success-foreground`). Never write raw
colours, never add `dark:` colour overrides, and never redefine these
variables on a surface. The `--surface-*`, `--text-*`, `--accent-*`,
`--feedback-*` primitives are the brand palette the layer maps from; new code
reads the shadcn names. `--ws-*` layout tokens (spacing, widths, touch target,
reading font) stay available for layout.

Badge variants: `default`, `secondary`, `destructive`, `outline`, `ghost`,
`link`, `success`, `info`, `warning`. Button variants and sizes are those of
`src/components/ui/button.tsx`; ADR 0255 adds `size="wrap"` (a decision that
wraps) and `size="inline"` (a link in text), and makes every Button a 44 px
target on a coarse pointer. Other sizes added once (ADR 0255): `Empty
size="compact"` / `variant="outline"`, `Card size="compact"`, `Item
size="compact"`, `Alert variant="warning"`, `FieldLabel variant="option"`,
`SidebarMenuSubButton size="lg"`; `SidebarMenuButton` takes `size` from
`useSidebarMenuSize()`. Never write `pointer-coarse:min-h-*`,
`kubecode-touch-target`, `h-auto p-0`, `p-4` on `Empty`, `py-0 gap-0` on
`Card`, `p-0` on `Item` or `font-normal` on `FieldLabel` at a call site.

## 4. CSS ownership

| Owner | May style |
| --- | --- |
| A #255 | `src/index.css` tokens and base layer; `src/components/ui/`, `src/components/ai-elements/` (via CLI updates and `cva` variants only); `src/components/workspace/` layout classes |
| B–H | layout of their own containers (`.kubecode-<surface>-*` classes they render): grid, flex, gap, width, overflow, position, responsive breakpoints |

Nobody may:

- select an official component's internals in `kubecode.css`
  (`[data-slot=…]`, `[cmdk-…]`, `[data-radix-…]`, or the component's own
  classes) to change colour, typography, radius, shadow, padding or internal
  layout;
- use `!important`;
- stack descendant selectors to beat a component's specificity.

`pnpm lint` runs `scripts/check-css-ownership.mjs` over every `.css` file
under `src/` against the product TSX (ADR 0255 §6). It flags official and
third-party internals and `!important`; a size, padding, border, radius,
font or colour declaration in a rule whose subject is a class an official
component carries as `className`; a rule that reaches an element or
`[role=…]` through a combinator; and dead classes both ways. Entries are
matched by file, enclosing selector and line text. Official components keep
their own `rem` type scale on the 14px root (a default Button is `text-sm`,
12.25px); do not restore `font-size: inherit`. Existing findings are listed
in `scripts/css-ownership-baseline.json` with an owner (187 after #277);
each slice removes its entries (the check fails on stale entries, so delete
the entry with the rule) and may not add new ones. Exceptions kept by ADR
0247: the xterm viewport and the `prefers-reduced-motion` block.

## 5. Portals

Overlays render in portals under `body`. They are themed because the tokens
live on the root: never theme an overlay through an ancestor class, never set
`z-index` on overlay components, and never pass colour classes to
`*Content`. A surface that needs a different width passes a layout class to
`DialogContent`/`PopoverContent`.

## 6. Icons

`lucide-react` only (`components.json` `iconLibrary: "lucide"`). Workspace
glyphs come from `src/kubecode/icons/workspaceIcons.ts` (one glyph and one
locale key per destination, command and object). Icons inside `Button` use
`data-icon="inline-start" | "inline-end"` and no sizing classes. Swap any
non-lucide icon a registry item brings before committing.

## 7. Adding or updating components

```bash
pnpm dlx shadcn@4.22.1 info                       # must print the config
pnpm dlx shadcn@latest add <component>            # built-in @shadcn registry
pnpm dlx shadcn@latest add @ai-elements/<name>    # AI Elements
pnpm dlx shadcn@latest add <component> --dry-run  # preview
pnpm dlx shadcn@latest add <component> --diff <file>
```

`@shadcn` is the CLI's built-in, reserved registry. Do not declare it under
`registries` in `components.json`: the CLI then rejects the whole file with
"Invalid configuration" (ADR 0254). Only third-party registries such as
`@ai-elements` (`https://elements.ai-sdk.dev/api/registry/{name}.json`,
ADR 0255 §4) belong there. The shadcn-hosted AI Elements are copy-paste
patterns whose `trace`/`code-block` dependencies are not published for the
`new-york` style; copy a pattern's source from its page and record it.

Review the added files (composition, groups, titles, lucide icons, locale
strings for any visible English), add a new dependency only with an ADR, and
record the registry item in your slice's ADR. Do not hand-copy registry
source.

## 8. Checks for every slice

`npx tsc -b --force`, `pnpm lint` (includes the CSS ownership check),
`pnpm test:coverage` (all four metrics ≥ 70%), `pnpm l10n:validate`,
`node scripts/validate-docs.mjs`, `pnpm playwright:smoke`, and before/after
screenshots of the real pages at 1440 and 390 px, light and dark, with de-DE
long copy. Update your inventory rows when a row changes status.
