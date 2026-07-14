# Public Docs Plan

This document records the phase 1 information architecture for public Tolaria documentation. The public docs source lives in `site/`; the existing `docs/` directory remains contributor, architecture, and agent context.

## Audiences

| Audience | Needs | Primary location |
|---|---|---|
| New users | Install, first launch, understand the app layout, clone the starter vault | `site/start/` |
| Active users | Learn concrete workflows such as organizing, Git sync, custom views, and AI | `site/guides/` |
| Power users | Understand file layout, frontmatter, filters, release channels, shortcuts, and platform support | `site/reference/` |
| Contributors and agents | Architecture, abstractions, ADRs, development workflow | `docs/`, `AGENTS.md` |

## Hosting Shape

The GitHub Pages output should reserve the root for public docs and mount release assets underneath it:

```text
/                  public docs home
/releases/         release history
/download/         latest stable download redirect
/stable/latest.json
/alpha/latest.json
/latest.json       compatibility alias for alpha latest
/latest-canary.json compatibility alias for alpha latest
```

## Current Coverage

The phase 1 site now covers post-branch features added after the original April docs snapshot:

- Windows and Linux release artifacts.
- Stable and Alpha updater channels.
- Direct AI model providers and local/API model setup.
- Claude Code, Codex, OpenCode, Pi, and Antigravity CLI agent targets.
- Explicit MCP setup for external AI tools.
- Table of contents, note width, raw mode, and paste-without-formatting workflows.
- Media/PDF previews, image attachments, All Notes visibility, and Markdown whiteboards.
- System theme mode and sidebar pluralization settings.

Every user-visible app change should answer:

```text
Public docs impact:
- updated: <pages>
- not needed because: <reason>
```
