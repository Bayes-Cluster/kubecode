use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, ToolCall, ToolCallStatus, ToolCallUpdate,
};
use serde_json::{Value, json};

use crate::agents::AgentEventKind;

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
    (
        AgentEventKind::ToolStarted,
        json!({
            "tool_id": tool_call.tool_call_id.to_string(),
            "tool": tool_call.title,
            "input": tool_call.raw_input,
            "output": tool_call.raw_output,
            "status": tool_call.status,
            "content": tool_call.content,
        }),
    )
}

pub(super) fn tool_updated(update: ToolCallUpdate) -> (AgentEventKind, Value) {
    let kind = match update.fields.status {
        Some(ToolCallStatus::Completed | ToolCallStatus::Failed) => AgentEventKind::ToolCompleted,
        _ => AgentEventKind::ToolUpdated,
    };
    (
        kind,
        json!({
            "tool_id": update.tool_call_id.to_string(),
            "tool": update.fields.title,
            "input": update.fields.raw_input,
            "output": update.fields.raw_output,
            "status": update.fields.status,
            "content": update.fields.content,
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
}
