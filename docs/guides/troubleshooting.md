# Troubleshooting

[Documentation](../README.md) · [简体中文](../zh-CN/guides/troubleshooting.md)

## An Agent is unavailable

Open the Agent picker or Settings and inspect the discovery diagnostic. Confirm
that:

1. the CLI executable exists and is executable by the Kubecode server user;
2. it is reachable through `PATH` or an explicit discovery override;
3. the CLI can print its version without interactive setup;
4. the Claude or Codex ACP adapter exists in
   `packaging/adapter-runtime/node_modules/.bin` for source development.

Restart Kubecode after changing executable paths because discovery occurs at
server startup.

## ACP connection failed

Run the Agent CLI directly from the same Project directory and verify that it is
authenticated. Then run the opt-in real-Agent smoke test. Do not paste provider
configuration files or API keys into an issue.

For OpenCode directory failures, compare:

```bash
pwd
git rev-parse --show-toplevel
opencode acp --cwd "$PWD"
```

The Project must still exist, the Kubecode Project record must resolve to the
same canonical directory, and the server user must have access to it. A Team
member should inherit the resolved member workspace rather than a null or stale
path.

## Reverse-proxy page or WebSocket fails

- Confirm `KUBECODE_BASE_PATH` exactly matches the externally exposed path.
- Check the unprefixed `/healthz` and `/readyz` health endpoints.
- Confirm the proxy forwards WebSocket upgrades.
- Confirm the proxy removes or preserves the path consistently with the server
  base-path setting.
- Set `KUBECODE_INTERNAL_ORIGIN` only for Agent-to-Team-MCP reachability.

## A Session or Team looks stale after restart

Refresh the page once and inspect the application message center. Kubecode
rehydrates Projects, Sessions, Teams, and status independently so one failed
request should not hide the others.

If a Team remains in `needs_attention`, inspect member status, pending
permissions, blocked tasks, and provider limits. Resume the Team only after the
underlying condition is resolved.

## Terminal does not close

After `exit` or `Ctrl+D`, check whether the shell process actually exited or is
waiting on a child process. A completed PTY should disappear from the terminal
list. Server logs should include a process-exit event without exposing terminal
contents.

## Git diff returns an error

Confirm the selected path is relative to the Project root and still exists in
the repository. Refresh Git status before reopening a diff. For submodules,
renames, binary files, or unusual worktree states, inspect the same path with
local Git before reporting a Kubecode bug.

## Notifications do not appear

1. enable the category in Settings;
2. select `Always` while testing;
3. grant browser Notification permission;
4. use **Send test**;
5. check OS focus/do-not-disturb settings.

In-app messages continue to work when browser notifications are denied.

## Reporting a bug

Include:

- Kubecode commit;
- browser, Linux distribution, and architecture;
- installation method and `KUBECODE_BASE_PATH`;
- Agent name and version;
- concise reproduction steps;
- relevant logs with credentials, paths, prompts, filenames, and file contents
  removed.

Security vulnerabilities must follow [SECURITY.md](../../SECURITY.md).
