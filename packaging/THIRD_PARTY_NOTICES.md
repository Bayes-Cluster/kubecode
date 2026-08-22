# Third-party runtime notices

Kubecode standalone releases include the following runtime components:

- Node.js, MIT License.
- `@agentclientprotocol/claude-agent-acp`, Apache License 2.0.
- `@agentclientprotocol/codex-acp`, Apache License 2.0.
- The production dependencies of those ACP adapters under their respective
  package licenses.
- `lucide-react`, ISC License (bundled workbench icons).
- `@remixicon/react`, Apache License 2.0 / Remix Icon License 1.0 (bundled
  filled-role icons).
- `@phosphor-icons/react`, MIT License (historical; retained only while shared
  UI primitives alias it, see ADR 0209).
- Material Icon Theme vendored icon subset, MIT License, from
  `material-extensions/vscode-material-icon-theme` at commit
  `48a530c7a849d902deafa805a27c13fec731de3c`; license copy and pin recorded in
  `scripts/material-icons/LICENSE`.

The standalone archive includes Node.js's `LICENSE` file and the license files
distributed with the adapter runtime packages. Claude Code, Codex, and OpenCode
Agent CLIs are not distributed as part of Kubecode.
