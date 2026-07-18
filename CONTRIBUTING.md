# Contributing to Kubecode

Keep changes focused on the project-based Kubeflow web workspace. Before
submitting a change:

- add a regression test for behavior changes;
- use the existing shadcn components and semantic theme tokens;
- keep browser paths relative to `NB_PREFIX`;
- keep filesystem operations behind `WorkspaceService`;
- do not add provider credentials or model APIs to Kubecode;
- update the architecture documentation for structural changes.

Run the checks listed in [README.md](README.md#quality-checks). Bug reports
should include the commit, browser, deployment environment, reproduction steps,
and relevant server logs without credentials or project content.

## Documentation

`README.md` and `docs/` are the canonical English sources. User-facing
documentation has a complete Simplified Chinese mirror in `README.zh-CN.md` and
`docs/zh-CN/`; update both languages in the same change. Architecture,
abstraction, and ADR documents remain English-only.

Keep commands, paths, configuration keys, Agent names, and behavior identical
between translations. Do not add screenshots containing real user paths,
project names, prompts, browser tabs, credentials, or file contents.

Run the documentation check before submitting:

```bash
pnpm docs:check
```
