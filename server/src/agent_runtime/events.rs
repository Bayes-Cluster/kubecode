use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, StopReason, ToolCall, ToolCallStatus, ToolCallUpdate,
};
use serde_json::{Value, json};

use crate::agents::{AgentEventKind, RunStatus, TerminalCause};

/// Maps an ACP prompt stop reason onto the local terminal status and the
/// typed cause carried on completion events. An agent-reported cancel keeps
/// the cancelled status; every other reported reason is a completed turn
/// whose cause says why it ended. Unknown future reasons default to
/// `end_turn`, matching the protocol's "turn ended" baseline.
pub(super) fn terminal_outcome(stop_reason: StopReason) -> (RunStatus, TerminalCause) {
    match stop_reason {
        StopReason::EndTurn => (RunStatus::Completed, TerminalCause::EndTurn),
        StopReason::Cancelled => (RunStatus::Cancelled, TerminalCause::Cancelled),
        StopReason::MaxTokens => (RunStatus::Completed, TerminalCause::MaxTokens),
        StopReason::MaxTurnRequests => (RunStatus::Completed, TerminalCause::MaxTurnRequests),
        StopReason::Refusal => (RunStatus::Completed, TerminalCause::Refusal),
        _ => (RunStatus::Completed, TerminalCause::EndTurn),
    }
}

pub(super) fn text_event(
    kind: AgentEventKind,
    chunk: ContentChunk,
) -> Option<(AgentEventKind, Value)> {
    let message_id = chunk.message_id.map(|value| value.to_string());
    let meta = chunk.meta;
    match chunk.content {
        ContentBlock::Text(text) => {
            let mut payload = json!({"text": text.text});
            if let Value::Object(object) = &mut payload {
                if let Some(message_id) = message_id {
                    object.insert("message_id".into(), Value::String(message_id));
                }
                if let Some(meta) = meta {
                    object.insert("_meta".into(), serde_json::to_value(meta).ok()?);
                }
            }
            Some((kind, payload))
        }
        _ => None,
    }
}

pub(super) fn tool_started(tool_call: ToolCall) -> (AgentEventKind, Value) {
    let content = tool_call.content;
    let has_content = !content.is_empty();
    (
        AgentEventKind::ToolStarted,
        json!({
            "tool_id": tool_call.tool_call_id.to_string(),
            "tool": tool_call.title,
            "input": if has_content { None } else { tool_call.raw_input },
            "output": if has_content { None } else { tool_call.raw_output },
            "status": tool_call.status,
            "content": content,
        }),
    )
}

pub(super) fn tool_updated(update: ToolCallUpdate) -> (AgentEventKind, Value) {
    let kind = match update.fields.status {
        Some(ToolCallStatus::Completed | ToolCallStatus::Failed) => AgentEventKind::ToolCompleted,
        _ => AgentEventKind::ToolUpdated,
    };
    let content = update.fields.content;
    let has_content = content.as_ref().is_some_and(|value| !value.is_empty());
    (
        kind,
        json!({
            "tool_id": update.tool_call_id.to_string(),
            "tool": update.fields.title,
            "input": if has_content { None } else { update.fields.raw_input },
            "output": if has_content { None } else { update.fields.raw_output },
            "status": update.fields.status,
            "content": content,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{TextContent, ToolCallId, ToolCallUpdateFields};
    use serde_json::json;

    #[test]
    fn maps_acp_content_and_tool_updates_to_shared_events() {
        let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("done")));
        chunk.message_id = Some("message-1".into());
        let text = text_event(AgentEventKind::TextDelta, chunk).expect("text event");
        assert_eq!(text.1["text"], "done");
        assert_eq!(text.1["message_id"], "message-1");

        let tool = tool_updated(ToolCallUpdate::new(
            ToolCallId::new("tool-1"),
            ToolCallUpdateFields::new()
                .title("Shell".to_owned())
                .status(ToolCallStatus::Completed)
                .raw_output(json!({"stdout":"ok"})),
        ));
        assert_eq!(tool.0, AgentEventKind::ToolCompleted);
        assert_eq!(tool.1["tool_id"], "tool-1");

        let started = tool_started(
            ToolCall::new(ToolCallId::new("startup-1"), "MCP startup")
                .status(ToolCallStatus::Failed)
                .content(vec![
                    ContentBlock::Text(TextContent::new("connection refused")).into(),
                ]),
        );
        assert_eq!(started.1["status"], "failed");
        assert_eq!(
            started.1["content"][0]["content"]["text"],
            "connection refused"
        );
    }

    #[test]
    fn maps_every_reported_stop_reason_to_a_typed_terminal_cause() {
        for (reason, status, cause) in [
            (StopReason::EndTurn, RunStatus::Completed, "end_turn"),
            (StopReason::Cancelled, RunStatus::Cancelled, "cancelled"),
            (StopReason::MaxTokens, RunStatus::Completed, "max_tokens"),
            (
                StopReason::MaxTurnRequests,
                RunStatus::Completed,
                "max_turn_requests",
            ),
            (StopReason::Refusal, RunStatus::Completed, "refusal"),
        ] {
            let (mapped_status, mapped_cause) = terminal_outcome(reason);
            assert_eq!(mapped_status, status, "{reason:?}");
            assert_eq!(mapped_cause.as_str(), cause, "{reason:?}");
        }
    }
}
