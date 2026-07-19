# Agent Sessions

[Documentation](../README.md) · [简体中文](../zh-CN/guides/agent-sessions.md)

## Supported Agents

Kubecode currently supports Claude Code, Codex, and OpenCode. Agent discovery
runs when the server starts and reports the resolved executable, version, and
diagnostics for unavailable Agents.

Claude Code and Codex use project-installed ACP adapters. OpenCode exposes ACP
through `opencode acp`. Authentication and provider configuration remain
external to Kubecode.

## Create or import a Session

Select a Project and choose **New session**:

1. choose an available Agent;
2. optionally enter a title;
3. choose direct Project or Workspace mode;
4. select an Agent-native mode, model, effort, or other advertised setting;
5. start the Session.

If the title is empty, Kubecode derives a short title from the first useful
conversation activity. Titles remain editable.

Import lists provider-native Sessions exposed by the selected Agent. Importing
registers the Session with Kubecode and hydrates available history; it does not
duplicate or delete provider history.

## ACP capabilities

Kubecode renders the capabilities advertised by the active Agent rather than
maintaining a universal provider abstraction. Depending on the Agent, the UI
may expose:

- native slash commands;
- Session resume and fork;
- model, mode, effort, or fast-mode configuration;
- structured plans, todos, tool calls, and checkpoints;
- permission choices supplied by the Agent;
- structured questions;
- Markdown and LaTeX output.

An absent control usually means that the current adapter or Session did not
advertise that capability.

## Composer

The Composer remains editable while an Agent is running. Submit behavior is
controlled by the current Session state; interrupt the active turn when the
Agent must stop before receiving a replacement instruction.

The **+** menu attaches Project files or Agent-supported skills. Agent
configuration is grouped into one capability menu so provider-specific options
do not crowd the input row.

## Permissions

Kubecode does not add a Safe/Power permission mode. When an Agent requests
permission, Kubecode shows the exact options supplied by that Agent. The user
can allow, allow for the relevant scope when provided, or reject.

Provider-native settings are the authority. A selection that the Agent does not
advertise is never guessed from a display label.

## Edit, branch, and undo

Provider Sessions are append-oriented. Editing a previously sent message
creates a revised Kubecode timeline backed by a new provider continuation when
the Agent cannot rewind safely. Kubecode keeps the logical Session stable and
hides synthetic reconstruction messages.

Undo uses captured turn checkpoints. It can fail when the provider did not
produce a safe after-turn checkpoint or when the workspace changed outside the
captured turn. Read the application message before retrying.

## Delete semantics

**Delete** removes the Session, runs, revisions, and normalized events from
Kubecode. It disconnects an active actor but does not request deletion of
provider-native history. A provider Session can be imported again when the
Agent exposes it.
