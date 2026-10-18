use std::sync::Arc;

use super::*;
use crate::agents::AgentId;
use crate::experiment_store::testing::Fixture;
use crate::research_store::ResearchBrief;

struct Rig {
    f: Fixture,
    channels: ChannelStore,
}

fn rig() -> Rig {
    let f = Fixture::new();
    let channels = ChannelStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap();
    Rig { f, channels }
}

impl Rig {
    fn project(&self) -> &str {
        &self.f.project_id
    }

    fn channel(&self) -> Channel {
        self.channels.default_channel(self.project()).unwrap()
    }

    fn say(&self, channel: &Channel, body: &str) -> Message {
        self.channels
            .post(
                self.project(),
                &channel.id,
                NewMessage {
                    body,
                    ..Default::default()
                },
            )
            .unwrap()
            .0
    }

    fn session(&self, title: &str) -> String {
        self.f
            .agents
            .create_conversation(self.project(), AgentId::OpenCode, Some(title))
            .unwrap()
            .id
    }

    fn question(&self, title: &str) -> String {
        self.f
            .research
            .create(
                self.project(),
                ResearchBrief {
                    title: title.into(),
                    question: "Why?".into(),
                    ..Default::default()
                },
                None,
            )
            .unwrap()
            .0
            .id
    }
}

#[test]
fn every_project_has_exactly_one_default_channel_and_others_cannot_see_it() {
    let r = rig();
    let first = r.channel();
    let again = r.channel();
    assert_eq!(first.id, again.id);
    assert!(first.is_default);
    assert_eq!(r.channels.channels(r.project()).unwrap().len(), 1);

    let other = r.f.workspace.create_project(".", "beta").unwrap();
    let theirs = r.channels.default_channel(&other.id).unwrap();
    assert_ne!(theirs.id, first.id);
    assert!(matches!(
        r.channels.channel(&other.id, &first.id),
        Err(ChannelError::NotFound)
    ));
    assert!(matches!(
        r.channels.post(
            &other.id,
            &first.id,
            NewMessage {
                body: "hello",
                ..Default::default()
            }
        ),
        Err(ChannelError::NotFound)
    ));
}

#[test]
fn messages_are_sequenced_attributed_and_replays_do_not_duplicate() {
    let r = rig();
    let channel = r.channel();
    let post = |body: &'static str, key: &'static str| {
        r.channels.post(
            r.project(),
            &channel.id,
            NewMessage {
                body,
                client_message_id: Some(key),
                ..Default::default()
            },
        )
    };
    let (first, created) = post("first", "m-1").unwrap();
    assert!(created);
    assert_eq!((first.seq, first.author_kind), (1, AuthorKind::Researcher));
    let (replayed, created) = post("first", "m-1").unwrap();
    assert!(!created, "a replay returns the stored message");
    assert_eq!(replayed.id, first.id);
    assert!(matches!(
        post("something else", "m-1"),
        Err(ChannelError::KeyReuse)
    ));
    let (second, _) = post("second", "m-2").unwrap();
    assert_eq!(second.seq, 2, "sequence numbers have no gaps");
    assert_eq!(r.channel().last_seq, 2);
}

#[test]
fn pages_scroll_back_and_catch_up_without_gaps_or_repeats() {
    let r = rig();
    let channel = r.channel();
    for n in 1..=5 {
        r.say(&channel, &format!("message {n}"));
    }
    let page = |before: Option<u64>, after: Option<u64>| {
        r.channels
            .messages(
                r.project(),
                &channel.id,
                MessageQuery {
                    scope: Scope::Channel,
                    before_seq: before,
                    after_seq: after,
                    limit: Some(2),
                },
            )
            .unwrap()
    };
    let seqs = |page: &MessagePage| page.messages.iter().map(|m| m.seq).collect::<Vec<_>>();
    let latest = page(None, None);
    assert_eq!((seqs(&latest), latest.has_more), (vec![4, 5], true));
    let older = page(Some(4), None);
    assert_eq!((seqs(&older), older.has_more), (vec![2, 3], true));
    let oldest = page(Some(2), None);
    assert_eq!((seqs(&oldest), oldest.has_more), (vec![1], false));
    let newer = page(None, Some(3));
    assert_eq!(seqs(&newer), vec![4, 5]);
    assert!(page(None, Some(5)).messages.is_empty());
}

#[test]
fn a_thread_keeps_its_replies_apart_from_the_channel_timeline() {
    let r = rig();
    let channel = r.channel();
    let root = r.say(&channel, "What about pruning?");
    let other = r.say(&channel, "Unrelated topic");
    let (thread, created) = r
        .channels
        .start_thread(r.project(), &channel.id, &root.id, None, None)
        .unwrap();
    assert!(created);
    assert_eq!(thread.title, "What about pruning?");
    let (again, created) = r
        .channels
        .start_thread(r.project(), &channel.id, &root.id, Some("ignored"), None)
        .unwrap();
    assert!(!created, "starting a Thread twice is a no-op");
    assert_eq!(again.id, thread.id);

    let (reply, _) = r
        .channels
        .post(
            r.project(),
            &channel.id,
            NewMessage {
                thread_id: Some(&thread.id),
                body: "Try magnitude pruning",
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(reply.thread_id.as_deref(), Some(thread.id.as_str()));

    let timeline = r
        .channels
        .messages(r.project(), &channel.id, MessageQuery::default())
        .unwrap();
    assert_eq!(
        timeline.messages.iter().map(|m| &m.id).collect::<Vec<_>>(),
        vec![&root.id, &other.id],
        "replies stay out of the channel timeline"
    );
    let in_thread = r
        .channels
        .messages(
            r.project(),
            &channel.id,
            MessageQuery {
                scope: Scope::Thread(&thread.id),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        in_thread.messages.iter().map(|m| &m.id).collect::<Vec<_>>(),
        vec![&root.id, &reply.id]
    );
    let listed = r.channels.threads(r.project(), &channel.id, None).unwrap();
    assert_eq!((listed[0].reply_count, listed[0].last_seq), (1, 3));
    // A reply cannot go to a Thread that is not there.
    assert!(matches!(
        r.channels.post(
            r.project(),
            &channel.id,
            NewMessage {
                thread_id: Some("nope"),
                body: "lost",
                ..Default::default()
            }
        ),
        Err(ChannelError::ThreadNotFound)
    ));
    // Only a top-level message starts a Thread.
    assert!(
        r.channels
            .start_thread(r.project(), &channel.id, &reply.id, None, None)
            .is_err()
    );
}

#[test]
fn two_questions_share_a_channel_with_their_own_threads_and_links_keep_the_conversation() {
    let r = rig();
    let channel = r.channel();
    let (pruning, _) = r
        .channels
        .start_thread(
            r.project(),
            &channel.id,
            &r.say(&channel, "Pruning ideas").id,
            None,
            None,
        )
        .unwrap();
    let (quant, _) = r
        .channels
        .start_thread(
            r.project(),
            &channel.id,
            &r.say(&channel, "Quantization ideas").id,
            None,
            None,
        )
        .unwrap();
    let rq_a = r.f.research_id.clone();
    let rq_b = r.question("Quantization");

    let before = r
        .channels
        .messages(
            r.project(),
            &channel.id,
            MessageQuery {
                scope: Scope::Thread(&pruning.id),
                ..Default::default()
            },
        )
        .unwrap();
    // A stale link is refused with the current revision.
    assert!(matches!(
        r.channels
            .link_thread(r.project(), &pruning.id, 9, Some(&rq_a), None),
        Err(ChannelError::Stale { current: 1 })
    ));
    let linked = r
        .channels
        .link_thread(
            r.project(),
            &pruning.id,
            1,
            Some(&rq_a),
            Some(&r.f.round_id),
        )
        .unwrap();
    assert_eq!(
        (linked.research_id.as_deref(), linked.revision),
        (Some(rq_a.as_str()), 2)
    );
    r.channels
        .link_thread(r.project(), &quant.id, 1, Some(&rq_b), None)
        .unwrap();

    // The original messages are untouched; the link is a system message after them.
    let after = r
        .channels
        .messages(
            r.project(),
            &channel.id,
            MessageQuery {
                scope: Scope::Thread(&pruning.id),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(after.messages[0], before.messages[0]);
    let note = after.messages.last().unwrap();
    assert_eq!(
        (note.kind, note.author_kind),
        (MessageKind::System, AuthorKind::System)
    );
    assert!(
        note.references
            .iter()
            .any(|reference| reference.id == rq_a && reference.kind == ContextKind::Research)
    );
    // Each question sees only its own discussion.
    let for_a = r
        .channels
        .threads(r.project(), &channel.id, Some(&rq_a))
        .unwrap();
    assert_eq!(
        for_a.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&pruning.id]
    );
    let for_b = r
        .channels
        .threads(r.project(), &channel.id, Some(&rq_b))
        .unwrap();
    assert_eq!(
        for_b.iter().map(|t| &t.id).collect::<Vec<_>>(),
        vec![&quant.id]
    );

    // Repeating the current link is a no-op; a round of another question is refused.
    let same = r
        .channels
        .link_thread(
            r.project(),
            &pruning.id,
            2,
            Some(&rq_a),
            Some(&r.f.round_id),
        )
        .unwrap();
    assert_eq!(same.revision, 2);
    assert!(
        r.channels
            .link_thread(r.project(), &quant.id, 2, Some(&rq_b), Some(&r.f.round_id))
            .is_err()
    );
    // Unlinking keeps every message.
    let unlinked = r
        .channels
        .link_thread(r.project(), &pruning.id, 2, None, None)
        .unwrap();
    assert_eq!((unlinked.research_id, unlinked.revision), (None, 3));
    assert!(
        r.channels
            .messages(
                r.project(),
                &channel.id,
                MessageQuery {
                    scope: Scope::Thread(&pruning.id),
                    ..Default::default()
                },
            )
            .unwrap()
            .messages
            .len()
            >= 3
    );
}

#[test]
fn links_and_references_reach_only_records_of_this_project() {
    let r = rig();
    let channel = r.channel();
    let root = r.say(&channel, "topic");
    let (thread, _) = r
        .channels
        .start_thread(r.project(), &channel.id, &root.id, None, None)
        .unwrap();
    let other = r.f.workspace.create_project(".", "beta").unwrap();
    let foreign =
        r.f.research
            .create(
                &other.id,
                ResearchBrief {
                    title: "Theirs".into(),
                    question: "?".into(),
                    ..Default::default()
                },
                None,
            )
            .unwrap()
            .0;
    assert!(
        r.channels
            .link_thread(r.project(), &thread.id, 1, Some(&foreign.id), None)
            .is_err(),
        "another Project's question reads like a missing one"
    );
    let post_with = |reference: ContextRef| {
        r.channels.post(
            r.project(),
            &channel.id,
            NewMessage {
                body: "see this",
                references: &[reference],
                ..Default::default()
            },
        )
    };
    assert!(post_with(ContextRef::new(ContextKind::Research, &foreign.id)).is_err());
    assert!(post_with(ContextRef::new(ContextKind::Finding, "no-such-finding")).is_err());
    assert!(post_with(ContextRef::new(ContextKind::Thread, "no-such-thread")).is_err());
    let rq = ContextRef::new(ContextKind::Research, &r.f.research_id);
    let round = ContextRef::new(ContextKind::Round, &r.f.round_id);
    let ok = post_with(rq.clone()).unwrap().0;
    assert_eq!(ok.references, vec![rq]);
    assert!(post_with(round).is_ok());
    assert!(post_with(ContextRef::new(ContextKind::Thread, &thread.id)).is_ok());
    // Threads and messages of this Project are invisible from another.
    assert!(matches!(
        r.channels.thread(&other.id, &thread.id),
        Err(ChannelError::ThreadNotFound)
    ));
    assert!(matches!(
        r.channels.message(&other.id, &root.id),
        Err(ChannelError::MessageNotFound)
    ));
}

#[test]
fn authorship_mentions_and_intents_are_validated() {
    let r = rig();
    let channel = r.channel();
    let session = r.session("Analyst");
    let post = |new: NewMessage<'_>| r.channels.post(r.project(), &channel.id, new);
    // A question names a Session that exists in this Project.
    assert!(
        post(NewMessage {
            body: "why?",
            intent: Some(Intent::Ask),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        post(NewMessage {
            body: "why?",
            intent: Some(Intent::Ask),
            mentions: &[Mention {
                session_id: "ghost".into()
            }],
            ..Default::default()
        })
        .is_err()
    );
    let mention = [Mention {
        session_id: session.clone(),
    }];
    let ask = post(NewMessage {
        body: "why?",
        intent: Some(Intent::Ask),
        mentions: &mention,
        ..Default::default()
    })
    .unwrap()
    .0;
    assert_eq!(ask.mentions, mention.to_vec());
    // Agents write as their Session and cannot request work.
    let agent = post(NewMessage {
        body: "done",
        author_kind: Some(AuthorKind::Agent),
        author_ref: Some(&session),
        ..Default::default()
    })
    .unwrap()
    .0;
    assert_eq!(agent.author_ref.as_deref(), Some(session.as_str()));
    assert!(
        post(NewMessage {
            body: "run it",
            author_kind: Some(AuthorKind::Agent),
            author_ref: Some(&session),
            intent: Some(Intent::Request),
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        post(NewMessage {
            body: "ghost speaks",
            author_kind: Some(AuthorKind::Agent),
            author_ref: Some("ghost"),
            ..Default::default()
        })
        .is_err()
    );
    // Limits.
    assert!(
        post(NewMessage {
            body: "   ",
            ..Default::default()
        })
        .is_err()
    );
    assert!(
        post(NewMessage {
            body: &"x".repeat(MAX_BODY_CHARS + 1),
            ..Default::default()
        })
        .is_err()
    );
}

#[test]
fn an_intent_is_claimed_exactly_once_and_a_replay_never_resets_it() {
    let r = rig();
    let channel = r.channel();
    let request = |key: &'static str| {
        r.channels
            .post(
                r.project(),
                &channel.id,
                NewMessage {
                    body: "Please organize the pruning sweep",
                    intent: Some(Intent::Request),
                    client_message_id: Some(key),
                    ..Default::default()
                },
            )
            .unwrap()
    };
    let (message, _) = request("req-1");
    let chat = r.say(&channel, "just talking");
    assert!(matches!(
        r.channels
            .claim_intent(r.project(), &chat.id, "orchestrator"),
        Err(ChannelError::NoIntent)
    ));
    assert_eq!(
        r.channels
            .unclaimed_intents(r.project(), 10)
            .unwrap()
            .iter()
            .map(|m| &m.id)
            .collect::<Vec<_>>(),
        vec![&message.id]
    );
    assert!(matches!(
        r.channels
            .claim_intent(r.project(), &message.id, "coordinator-1"),
        Ok(Claim::Claimed(_))
    ));
    // A second consumer, and the same one again, both see it is taken.
    assert_eq!(
        r.channels
            .claim_intent(r.project(), &message.id, "coordinator-2")
            .unwrap(),
        Claim::AlreadyClaimed {
            by: "coordinator-1".into()
        }
    );
    assert_eq!(
        r.channels
            .claim_intent(r.project(), &message.id, "coordinator-1")
            .unwrap(),
        Claim::AlreadyClaimed {
            by: "coordinator-1".into()
        }
    );
    // Replaying the submission neither duplicates the message nor re-opens the intent.
    let (replayed, created) = request("req-1");
    assert!(!created);
    assert_eq!(replayed.intent_claimed_by.as_deref(), Some("coordinator-1"));
    assert!(
        r.channels
            .unclaimed_intents(r.project(), 10)
            .unwrap()
            .is_empty()
    );
    // Another Project cannot claim it.
    let other = r.f.workspace.create_project(".", "beta").unwrap();
    assert!(matches!(
        r.channels.claim_intent(&other.id, &message.id, "x"),
        Err(ChannelError::MessageNotFound)
    ));
}

#[test]
fn events_announce_ids_and_change_words_never_message_text() {
    let r = rig();
    let channel = r.channel();
    r.say(&channel, "a very private research hunch");
    let payloads: Vec<String> =
        r.f.agents
            .database()
            .lock()
            .unwrap()
            .prepare("SELECT payload FROM workspace_events WHERE kind = 'channel_updated'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
    assert!(payloads.len() >= 2, "channel creation and the message");
    assert!(payloads.iter().all(|payload| !payload.contains("hunch")));
    assert!(
        payloads
            .iter()
            .any(|payload| payload.contains("\"message\""))
    );
}
