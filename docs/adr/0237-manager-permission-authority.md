---
type: ADR
id: "0237"
title: "The manager runs with full native permissions and reviews specialists' permission requests"
status: accepted
date: 2026-10-21
supersedes: "0226 §1, the manager's restricted launch profile and its refused or human-reviewed permission requests; 0220 §4, the sentence that bounds the manager's provider tools (native edit, delete, move, and command execution refused)"
---

## Context

ADR 0220 §4 and ADR 0226 §1 started the General Agent (the project manager)
with its provider's editing and shell tools withdrawn, refused any native
edit, delete, move, or execute permission request it made, and put every
other request it made to the researcher. Specialists' requests went to the
researcher too. In practice this made the researcher the reviewer of every
permission in every Workspace while the manager, the one agent that knows the
plan, could neither act nor judge.

The product owner decided:

- In every project the manager runs, by default, at the highest permission
  level its provider offers, and its own actions no longer ask the human.
- Every permission request from a specialist is reviewed by the manager
  first. The manager approves or denies it with a recorded reason, and may
  escalate it to the researcher when it is unsure.
- Every decision the manager makes is recorded and visible to the researcher
  afterwards. The manager reports; it does not hide what it approved.

## Decision

### 1. The manager launches with full native permissions

A Session whose member is, or was, the General Agent still starts with the
**Manager** permission profile (the roster is read on every start and an
unreadable roster still fails toward the Manager profile). The profile now
means full native access:

- Claude Code: no tools are withdrawn, and the mode is set to
  `bypassPermissions`.
- Codex: the mode is set to `agent-full-access`.
- OpenCode: the process starts with the same permissive
  `OPENCODE_PERMISSION` as a Maximum (Yolo) Team member.

The mode stays locked (`general_manager`): it is part of the profile, and a
narrower mode would only bring back prompts that the runtime answers anyway.
A permission request the manager's provider still makes is granted by the
runtime with its allow-once option (never an always option, so nothing is
added to always-allow memory) and recorded as a resolved permission event on
the run. It is never surfaced to the researcher.

The role boundaries of ADR 0220 §4 enforced in Kubecode's own services and
tools are unchanged: the manager is still never assigned work, does not launch
experiments as an executor, and admits Tasks only on the researcher's words.

### 2. Specialists' permission requests go to the manager

When a current specialist Session asks permission and is not answered from
always-allow memory (which only the researcher can write), the request waits
with `reviewer: "manager"`:

- It is not shown to the researcher as a prompt or in Needs you.
- One durable `permission_review` route (source: the permission request) is
  written to the General Agent's public Session, naming the specialist, the
  tool, and the request id, and asking it to review. The route follows the
  manager if its Session is replaced (ADR 0229).
- If the Workspace has no manager Session to route to, or the route cannot be
  written, the request is escalated to the researcher at once.

A request still waits until it is answered or its turn stops (ADR 0232).

### 3. The manager decides through `kubecode-work` tools

Two tools are added to the `kubecode-work` MCP server, usable only by the
General Agent's current Session (checked from persisted state on every call):

- `permission_reviews` lists the specialists' requests waiting on the
  manager in this Workspace: request id, member, tool title, the tool input
  (clipped), the offered options, and when it was asked.
- `permission_review` takes a request id, a decision (`approve`, `deny`, or
  `escalate`), and a required reason. Approve answers with the agent-offered
  allow option the manager names (allow-once by default; an always option is
  never used, so a manager approval adds nothing to always-allow memory). Deny
  answers with the reject-once option, or cancels the tool call when none is
  offered. Escalate hands the request to the researcher: it becomes a normal
  `reviewer: "user"` request in Needs you.

A request that is not waiting on the manager, or belongs to another Workspace,
is refused. The researcher may still answer a request waiting on the manager
directly; the first answer wins.

### 4. Every manager decision is recorded and shown

Each decision is written to `manager_permission_reviews` (Workspace, request,
run, Session, member, tool title, decision, chosen option, reason, time).
A `permission_reviewed` Workspace event announces it carrying only the request
id, the Session, and the decision; it carries no tool input, reason, prompt
content, or path. The attention snapshot lists the Workspace's most recent
decisions as `manager_decisions`, and Needs you shows them as information,
not as prompts. Analytics events never include the tool input or the reason.

## Consequences

- The researcher is asked about a permission only when the manager escalates
  it, when a non-member Session asks, or when there is no manager to ask.
- The manager can change the workspace directly with its provider's tools.
  The researcher sees its work in its Session and the manager's permission
  decisions in Needs you, but is not asked first.
- A route is durable while a waiting request is not: after a restart the
  request is gone (its turn stopped) and the tool says it is no longer
  waiting.
- The manager reviews requests through a prompt-delivered route, so a busy
  manager delays a specialist until its current turn ends. If that route
  fails for good, the request keeps waiting (its run shows as waiting for
  permission) until the researcher stops the turn; it is not escalated
  automatically.
- A real-agent pilot of the full-access launch and of the review loop has not
  been run; they are covered by tests of the launch configuration, the
  routing, and the tools.
