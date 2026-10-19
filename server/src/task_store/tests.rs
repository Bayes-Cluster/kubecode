use std::sync::Arc;

use super::*;
use crate::agents::AgentId;
use crate::channel_store::{AuthorKind as MessageAuthor, MessageQuery, Scope};
use crate::experiment_store::testing::Fixture;
use crate::member_store::{MemberTemplate, NewMember};
use crate::research_store::ResearchBrief;

struct Rig {
    f: Fixture,
    tasks: TaskStore,
    channels: Arc<ChannelStore>,
    work: Arc<WorkStore>,
    general: String,
    specialist: String,
}

const YES: &dyn Fn(AgentId) -> bool = &|_| true;

fn rig() -> Rig {
    let f = Fixture::new();
    let channels =
        Arc::new(ChannelStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let members =
        Arc::new(MemberStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let work =
        Arc::new(WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let general = members
        .ensure_general(&f.project_id, YES, AgentId::OpenCode)
        .unwrap()
        .public_conversation_id
        .unwrap();
    let specialist = members
        .create_specialist(
            &f.project_id,
            NewMember {
                name: "Analyst".into(),
                template: Some(MemberTemplate::Analysis),
                ..Default::default()
            },
            YES,
            AgentId::OpenCode,
        )
        .unwrap()
        .public_conversation_id
        .unwrap();
    let tasks = TaskStore::from_database(
        f.agents.database(),
        Arc::clone(&f.agents),
        Arc::clone(&f.research),
        Arc::clone(&channels),
        Arc::clone(&members),
        Arc::clone(&work),
    )
    .unwrap();
    Rig {
        f,
        tasks,
        channels,
        work,
        general,
        specialist,
    }
}

fn key(title: &str) -> String {
    title.replace(' ', "-")
}

fn brief(title: &str) -> ResearchBrief {
    ResearchBrief {
        title: title.into(),
        question: "Does head pruning hold accuracy?".into(),
        evaluation_criteria: vec!["within one point".into()],
        constraints: vec!["one GPU".into()],
        ..Default::default()
    }
}

impl Rig {
    fn project(&self) -> &str {
        &self.f.project_id
    }

    /// The researcher says something in General.
    fn say(&self, body: &str) -> Message {
        let channel = self.channels.default_channel(self.project()).unwrap();
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

    /// The researcher says something and attaches the Tasks it is about.
    fn say_about(&self, body: &str, tasks: &[&str]) -> Message {
        let channel = self.channels.default_channel(self.project()).unwrap();
        let references: Vec<ContextRef> = tasks
            .iter()
            .map(|id| ContextRef::new(ContextKind::Research, *id))
            .collect();
        self.channels
            .post(
                self.project(),
                &channel.id,
                NewMessage {
                    body,
                    references: &references,
                    ..Default::default()
                },
            )
            .unwrap()
            .0
    }

    /// The manager proposes a Task; returns its id and revision.
    fn proposed(&self, title: &str) -> (String, u64) {
        let (question, _) = self
            .tasks
            .propose(
                self.project(),
                &self.general,
                brief(title),
                Some(&key(title)),
            )
            .unwrap();
        (question.id, question.revision)
    }

    /// A proposal, shown, then the researcher's instruction: ready to admit.
    fn instructed(&self, title: &str) -> (String, u64, Message) {
        let (id, revision) = self.proposed(title);
        let instruction = self.say("Yes, add that to the board.");
        (id, revision, instruction)
    }

    fn texts(&self) -> Vec<String> {
        let channel = self.channels.default_channel(self.project()).unwrap();
        self.channels
            .messages(
                self.project(),
                &channel.id,
                MessageQuery {
                    scope: Scope::Channel,
                    ..Default::default()
                },
            )
            .unwrap()
            .messages
            .into_iter()
            .map(|m| m.body)
            .collect()
    }
}

#[test]
fn a_proposal_is_a_shown_draft_and_only_members_write_one() {
    let r = rig();
    let (id, revision) = r.proposed("Prune heads");
    let drafts = r.tasks.drafts(r.project()).unwrap();
    let draft = drafts.iter().find(|d| d.id == id).expect("a draft");
    assert_eq!((draft.proposed_by.as_str(), draft.revision), ("agent", 1));
    assert_eq!(revision, 1);
    assert!(
        r.tasks.board(r.project()).unwrap().cards.is_empty(),
        "drafts stay off the board"
    );
    assert!(
        r.texts()
            .iter()
            .any(|t| t.starts_with("Proposed Task: Prune heads") && t.contains("not on the board"))
    );
    // A specialist may propose; a Session that is not a member may not.
    r.tasks
        .propose(r.project(), &r.specialist, brief("Quantize"), None)
        .unwrap();
    let stranger =
        r.f.agents
            .create_conversation(r.project(), AgentId::OpenCode, Some("chat"))
            .unwrap()
            .id;
    assert!(matches!(
        r.tasks
            .propose(r.project(), &stranger, brief("Sneaky"), None),
        Err(TaskError::NotMember)
    ));
    // Proposing again with the same key is the same draft and the same message.
    let before = r.texts().len();
    let (again, _) = r
        .tasks
        .propose(
            r.project(),
            &r.general,
            brief("Prune heads"),
            Some("Prune-heads"),
        )
        .unwrap();
    assert_eq!(again.id, id);
    assert_eq!(r.texts().len(), before);
}

#[test]
fn the_researchers_instruction_admits_one_task_once_and_the_manager_says_so() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    let (admission, created) = r
        .tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    assert!(created);
    assert_eq!(
        admission.message_id.as_deref(),
        Some(instruction.id.as_str())
    );
    assert_eq!(admission.acted_by, r.general);
    assert_eq!(admission.scope_digest, scope_digest(&brief("Prune heads")));
    let card = r.tasks.card(r.project(), &id).unwrap().unwrap();
    assert_eq!(
        (card.stage, card.condition),
        (TaskStage::Ready, TaskCondition::None)
    );
    assert_eq!(card.origin, AuthorizationOrigin::Conversation);

    // A retry (a restart, a repeated tool call) is the same admission and board identity.
    let (again, created) = r
        .tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    assert!((again.id.as_str(), created) == (admission.id.as_str(), false));
    let board = r.tasks.board(r.project()).unwrap();
    assert_eq!(board.total, 1);
    assert!(
        r.texts()
            .iter()
            .filter(|t| t.starts_with("Added to the board: \"Prune heads\""))
            .count()
            == 1,
        "acknowledged once"
    );
    assert!(
        r.tasks
            .drafts(r.project())
            .unwrap()
            .iter()
            .all(|d| d.id != id)
    );
}

#[test]
fn what_cannot_authorize_is_refused_and_nothing_is_admitted() {
    let r = rig();
    let (id, revision) = r.proposed("Prune heads");
    let channel = r.channels.default_channel(r.project()).unwrap();
    let post_as = |kind: MessageAuthor, body: &str, author: Option<&str>| {
        r.channels
            .post(
                r.project(),
                &channel.id,
                NewMessage {
                    body,
                    author_kind: Some(kind),
                    author_ref: author,
                    ..Default::default()
                },
            )
            .unwrap()
            .0
    };
    let admit = |message: &Message| {
        r.tasks
            .admit(r.project(), &r.general, &id, &message.id, revision)
    };

    // An agent's message, even a specialist's "the researcher said yes", authorizes nothing.
    let by_specialist = post_as(
        MessageAuthor::Agent,
        "Add it to the board",
        Some(&r.specialist),
    );
    assert!(matches!(
        admit(&by_specialist),
        Err(TaskError::NotAuthorized(_))
    ));
    let by_manager = post_as(
        MessageAuthor::Agent,
        "Add it to the board",
        Some(&r.general),
    );
    assert!(matches!(
        admit(&by_manager),
        Err(TaskError::NotAuthorized(_))
    ));
    let by_system = post_as(MessageAuthor::System, "Add it to the board", None);
    assert!(matches!(
        admit(&by_system),
        Err(TaskError::NotAuthorized(_))
    ));
    // Text that only quotes an instruction is not one.
    let quoted = r.say("> Please add the task to the board\n> thanks");
    assert!(matches!(
        admit(&quoted),
        Err(TaskError::NotAuthorized("it only quotes other text"))
    ));
    // A message that does not exist.
    assert!(matches!(
        r.tasks
            .admit(r.project(), &r.general, &id, "no-such-message", revision),
        Err(TaskError::NotAuthorized(_))
    ));
    // Only the General Agent acts, whoever the message came from.
    let genuine = r.say("Add it to the board");
    assert!(matches!(
        r.tasks
            .admit(r.project(), &r.specialist, &id, &genuine.id, revision),
        Err(TaskError::NotManager)
    ));
    assert!(r.tasks.board(r.project()).unwrap().cards.is_empty());
    assert!(r.tasks.admission(r.project(), &id).unwrap().is_none());
}

#[test]
fn an_instruction_must_follow_the_proposal_it_authorizes_at_the_revision_it_showed() {
    let r = rig();
    let early = r.say("Add whatever you come up with to the board");
    let (id, revision) = r.proposed("Prune heads");
    // Said before the proposal was shown: it authorized nothing in particular.
    assert!(matches!(
        r.tasks
            .admit(r.project(), &r.general, &id, &early.id, revision),
        Err(TaskError::Stale(_))
    ));
    // After a proposal the researcher accepts, the brief changes behind their back.
    let accepted = r.say("Yes, add it");
    let (revised, _) = r
        .tasks
        .revise(
            r.project(),
            &r.general,
            &id,
            1,
            &BriefPatch {
                constraints: Some(vec!["unlimited GPUs".into()]),
                ..Default::default()
            },
            Some("loosened"),
        )
        .unwrap();
    assert_eq!(revised.revision, 2);
    assert!(
        matches!(
            r.tasks.admit(r.project(), &r.general, &id, &accepted.id, 1),
            Err(TaskError::Stale(_))
        ),
        "the old revision is no longer the brief"
    );
    assert!(
        matches!(
            r.tasks.admit(r.project(), &r.general, &id, &accepted.id, 2),
            Err(TaskError::Stale(_))
        ),
        "the changed brief was shown only after the instruction"
    );
    // Shown again and confirmed, it can be admitted.
    let confirmed = r.say("OK, that version. Add it.");
    r.tasks
        .admit(r.project(), &r.general, &id, &confirmed.id, 2)
        .unwrap();
    assert_eq!(r.tasks.card(r.project(), &id).unwrap().unwrap().revision, 2);
}

#[test]
fn one_instruction_authorizes_one_task_and_a_task_is_admitted_once() {
    let r = rig();
    let (first, rev_first) = r.proposed("Prune heads");
    let (second, rev_second) = r.proposed("Quantize");
    // The researcher answers after two proposals: which one they meant is unclear.
    let unclear = r.say("Yes, add that one");
    assert!(matches!(
        r.tasks.admit(r.project(), &r.general, &first, &unclear.id, rev_first),
        Err(TaskError::Stale(text)) if text.contains("more recently")
    ));
    // The manager asks, shows the one in question, and the researcher answers it.
    r.tasks.show_again(r.project(), &r.general, &first).unwrap();
    let instruction = r.say_about("Add the pruning one", &[&first, &second]);
    r.tasks
        .admit(r.project(), &r.general, &first, &instruction.id, rev_first)
        .unwrap();
    // Replaying the same words for another Task is refused.
    let replay = r.tasks.admit(
        r.project(),
        &r.general,
        &second,
        &instruction.id,
        rev_second,
    );
    assert!(matches!(replay, Err(TaskError::MessageUsed)), "{replay:?}");
    // And a Task already on the board is not admitted again by another message.
    let other = r.say("Add it again");
    assert!(matches!(
        r.tasks
            .admit(r.project(), &r.general, &first, &other.id, rev_first),
        Err(TaskError::State(_))
    ));
    assert_eq!(r.tasks.board(r.project()).unwrap().total, 1);
}

#[test]
fn admission_is_not_execution_and_execution_needs_its_own_instruction() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    // Not on the board yet: nothing to execute.
    assert!(matches!(
        r.tasks
            .start_execution(r.project(), &r.general, &id, &instruction.id),
        Err(TaskError::State(_))
    ));
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    assert!(
        r.f.research.rounds(r.project(), &id).unwrap().is_empty(),
        "admission starts no round"
    );

    // Another Task, admitted before the instruction below is given.
    let (other, rev) = r.proposed("Quantize");
    let admit_other = r.say("Add quantize too");
    r.tasks
        .admit(r.project(), &r.general, &other, &admit_other.id, rev)
        .unwrap();

    let go = r.say("Go ahead and run it.");
    let (execution, created) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    assert!(created);
    let round =
        r.f.research
            .round_by_id(r.project(), execution.round_id.as_deref().unwrap())
            .unwrap();
    assert_eq!(round.brief_revision, 1, "pinned to the approved revision");
    assert_eq!(round.session_id.as_deref(), Some(r.general.as_str()));
    let holder = r
        .work
        .coordinator(r.project(), &round.id)
        .unwrap()
        .unwrap()
        .holder;
    assert_eq!(holder, r.general, "the manager coordinates");
    let card = r.tasks.card(r.project(), &id).unwrap().unwrap();
    assert_eq!(card.stage, TaskStage::InProgress);
    assert_eq!(
        card.participants
            .iter()
            .map(|p| p.handle.as_str())
            .collect::<Vec<_>>(),
        ["general"]
    );
    // No limit and no experiment envelope was set by the authorization.
    assert_eq!(r.work.policy(r.project(), &round.id).unwrap().revision, 0);
    assert!(
        r.f.experiments
            .envelope(r.project(), &id, &round.id)
            .unwrap()
            .is_none()
    );

    // The same instruction again is the same execution, with no second round.
    let (again, created) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    assert!((again.id.as_str(), created) == (execution.id.as_str(), false));
    assert_eq!(r.f.research.rounds(r.project(), &id).unwrap().len(), 1);
    // Another Task cannot reuse it.
    assert!(matches!(
        r.tasks
            .start_execution(r.project(), &r.general, &other, &go.id),
        Err(TaskError::MessageUsed)
    ));
}

#[test]
fn a_revised_brief_waits_for_the_researchers_approval_before_it_can_run() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    // A specialist's idea becomes a proposed revision, not an approved scope.
    r.tasks
        .revise(
            r.project(),
            &r.general,
            &id,
            1,
            &BriefPatch {
                question: Some("Does it hold on every dataset, too?".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let card = r.tasks.card(r.project(), &id).unwrap().unwrap();
    assert_eq!((card.revision, card.approved_revision), (2, 1));
    let go = r.say("Run it");
    assert!(matches!(
        r.tasks.start_execution(r.project(), &r.general, &id, &go.id),
        Err(TaskError::State(text)) if text.contains("approval")
    ));
    // The researcher approves the revised brief in their words; then it can run.
    let approve = r.say("Yes, widen it to every dataset.");
    r.tasks
        .approve_revision(r.project(), &r.general, &id, &approve.id, 2)
        .unwrap();
    assert_eq!(
        r.tasks
            .card(r.project(), &id)
            .unwrap()
            .unwrap()
            .approved_revision,
        2
    );
    let (execution, _) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    let round =
        r.f.research
            .round_by_id(r.project(), execution.round_id.as_deref().unwrap())
            .unwrap();
    assert_eq!(round.brief_revision, 2);
    let notes = r.tasks.revisions(r.project(), &id).unwrap();
    assert_eq!(
        notes
            .iter()
            .map(|n| (n.revision, n.approved, n.author_kind.as_str()))
            .collect::<Vec<_>>(),
        [(1, true, "agent"), (2, true, "agent")]
    );
}

#[test]
fn the_manager_asks_for_review_and_the_researcher_completes_or_returns_the_task() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    // Nothing to review before work started; only the manager asks.
    assert!(
        r.tasks
            .request_review(r.project(), &r.specialist, &id, "done", &[])
            .is_err()
    );
    let go = r.say("Run it");
    r.tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    let (request, created) = r
        .tasks
        .request_review(
            r.project(),
            &r.general,
            &id,
            "Both ratios were run; 0.9 diverged.",
            &["finding:f1".into()],
        )
        .unwrap();
    assert!(created);
    assert_eq!(
        r.tasks.card(r.project(), &id).unwrap().unwrap().stage,
        TaskStage::Review
    );
    // Asking again with the same summary is the same request; a different one is refused.
    assert!(
        !r.tasks
            .request_review(
                r.project(),
                &r.general,
                &id,
                "Both ratios were run; 0.9 diverged.",
                &[]
            )
            .unwrap()
            .1
    );
    assert!(
        r.tasks
            .request_review(r.project(), &r.general, &id, "something else", &[])
            .is_err()
    );

    // Sending it back needs a reason and puts it back in progress.
    assert!(
        r.tasks
            .review(
                r.project(),
                &id,
                &request.id,
                false,
                WorkOutcome::Unknown,
                None
            )
            .is_err()
    );
    // A click on a review that is not the open one decides nothing.
    assert!(matches!(
        r.tasks.review(
            r.project(),
            &id,
            "stale-request",
            false,
            WorkOutcome::Unknown,
            Some("no")
        ),
        Err(TaskError::State(_))
    ));
    let returned = r
        .tasks
        .review(
            r.project(),
            &id,
            &request.id,
            false,
            WorkOutcome::Unknown,
            Some("also try 0.7"),
        )
        .unwrap();
    assert!(!returned.accepted);
    assert_eq!(
        r.tasks.card(r.project(), &id).unwrap().unwrap().stage,
        TaskStage::InProgress
    );
    assert!(
        r.tasks
            .review(
                r.project(),
                &id,
                &request.id,
                true,
                WorkOutcome::Supported,
                None
            )
            .is_err(),
        "nothing is open to accept"
    );

    // A valid negative finding completes the Task.
    let (second, _) = r
        .tasks
        .request_review(r.project(), &r.general, &id, "0.7 also diverges.", &[])
        .unwrap();
    assert_ne!(second.id, request.id);
    let accepted = r
        .tasks
        .review(
            r.project(),
            &id,
            &second.id,
            true,
            WorkOutcome::Refuted,
            Some("clean ablation"),
        )
        .unwrap();
    assert!(accepted.accepted);
    let card = r.tasks.card(r.project(), &id).unwrap().unwrap();
    assert_eq!(
        (card.stage, card.outcome),
        (TaskStage::Done, Some(WorkOutcome::Refuted))
    );
    assert_eq!(
        r.f.research.get(r.project(), &id).unwrap().status,
        ResearchStatus::Resolved
    );
    assert!(
        r.texts()
            .iter()
            .any(|t| t.contains("accepted as a valid negative result"))
    );
    // The record of the question keeps the decision.
    let entries = r.f.research.entries(r.project(), &id, 0, Some(50)).unwrap();
    assert!(
        entries
            .iter()
            .any(|e| e.body.contains("valid negative result"))
    );
    // Iterating afterwards reopens it.
    let again = r.say("Let's iterate on this");
    r.tasks
        .start_execution(r.project(), &r.general, &id, &again.id)
        .unwrap();
    assert_eq!(
        r.tasks.card(r.project(), &id).unwrap().unwrap().stage,
        TaskStage::InProgress
    );
    assert_eq!(
        r.f.research.get(r.project(), &id).unwrap().status,
        ResearchStatus::Open
    );
}

#[test]
fn a_round_the_researcher_already_started_is_admitted_as_such_and_nothing_else_is() {
    let r = rig();
    // The Fixture's question has a Team round; the researcher started it.
    r.f.research
        .round_mark_started(r.project(), &r.f.research_id, &r.f.round_id)
        .unwrap();
    // A question with discussion but no round, and one the researcher resolved.
    let (idle, _) =
        r.f.research
            .create(r.project(), brief("Idle"), None)
            .unwrap();
    let (resolved, _) =
        r.f.research
            .create(r.project(), brief("Resolved"), None)
            .unwrap();
    r.f.research
        .set_status(r.project(), &resolved.id, ResearchStatus::Resolved)
        .unwrap();

    let board = r.tasks.board(r.project()).unwrap();
    let ids: Vec<&str> = board.cards.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, [r.f.research_id.as_str()]);
    let card = &board.cards[0];
    assert_eq!(
        (card.stage, card.origin),
        (TaskStage::InProgress, AuthorizationOrigin::LegacyRound)
    );
    assert_eq!(card.authorizing_message_id, None);
    let admission = r
        .tasks
        .admission(r.project(), &r.f.research_id)
        .unwrap()
        .unwrap();
    assert_eq!(admission.acted_by, "migration");
    assert_eq!(admission.round_id.as_deref(), Some(r.f.round_id.as_str()));
    // No approval is invented for the rest.
    let drafts: Vec<String> = r
        .tasks
        .drafts(r.project())
        .unwrap()
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert!(drafts.contains(&idle.id) && drafts.contains(&resolved.id));
    // Re-reading adopts nothing twice.
    assert_eq!(r.tasks.adopt_legacy().unwrap(), 0);
    assert_eq!(
        r.tasks
            .authorizations(r.project(), &r.f.research_id)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn open_questions_and_pauses_show_as_conditions_not_stages() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    let go = r.say("Run it");
    let (execution, _) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    let round = execution.round_id.unwrap();
    let coordinator = {
        let current = r.work.coordinator(r.project(), &round).unwrap().unwrap();
        crate::work_store::Actor::Coordinator(crate::work_store::CoordinatorAuth {
            round_id: round.clone(),
            holder: current.holder,
            epoch: current.epoch,
        })
    };
    let (item, _) = r
        .work
        .create(
            r.project(),
            crate::work_store::NewWork {
                title: "Sweep",
                description: "Try ratios",
                round_id: Some(&round),
                ..Default::default()
            },
            &coordinator,
        )
        .unwrap();
    r.work
        .assign(r.project(), &item.id, &r.specialist, None, "", &coordinator)
        .unwrap();
    let card = r.tasks.card(r.project(), &id).unwrap().unwrap();
    assert_eq!(card.work.total, 1);
    let handles: Vec<&str> = card
        .participants
        .iter()
        .map(|p| p.handle.as_str())
        .collect();
    assert_eq!(
        handles,
        ["general", "analyst"],
        "the manager coordinates, the specialist executes"
    );
    assert_eq!(card.condition, TaskCondition::None);

    r.work
        .request_decision(
            r.project(),
            &item.id,
            "q",
            &r.specialist,
            "Spend more?",
            &[],
            None,
            None,
        )
        .unwrap();
    let card = r.tasks.card(r.project(), &id).unwrap().unwrap();
    assert_eq!(
        (card.stage, card.condition),
        (TaskStage::InProgress, TaskCondition::NeedsInput)
    );
    assert_eq!(card.open_questions, 1);
}

#[test]
fn instruction_text_ignores_quoted_lines_only() {
    assert_eq!(instruction_text("Add it\n> not mine"), "Add it");
    assert_eq!(instruction_text("> only a quote"), "");
    assert_eq!(
        instruction_text("  >indented quote\nreal words"),
        "real words"
    );
    assert_eq!(instruction_text("a > b"), "a > b");
}

// -- Hardening regressions (review of #200) ----------------------------------------------------------

#[test]
fn one_message_cannot_admit_and_start_or_serve_two_steps() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    // The words that added it to the board are not also the order to run it.
    let both = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &instruction.id);
    assert!(
        matches!(both, Err(TaskError::MessageUsed) | Err(TaskError::Stale(_))),
        "{both:?}"
    );
    assert!(r.f.research.rounds(r.project(), &id).unwrap().is_empty());
    // Nor does it approve a revision of another Task.
    let (other, rev) = r.proposed("Quantize");
    r.tasks
        .admit(
            r.project(),
            &r.general,
            &other,
            &r.say("Add quantize").id,
            rev,
        )
        .unwrap();
    r.tasks
        .revise(
            r.project(),
            &r.general,
            &other,
            1,
            &BriefPatch {
                question: Some("Quantize to 4 bits?".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let replay = r
        .tasks
        .approve_revision(r.project(), &r.general, &other, &instruction.id, 2);
    assert!(
        matches!(
            replay,
            Err(TaskError::MessageUsed) | Err(TaskError::Stale(_))
        ),
        "{replay:?}"
    );
    assert_eq!(
        r.tasks
            .card(r.project(), &other)
            .unwrap()
            .unwrap()
            .approved_revision,
        1
    );
}

#[test]
fn an_instruction_after_two_proposals_must_name_the_one_it_means() {
    let r = rig();
    let (first, rev_first) = r.proposed("Prune heads");
    let (second, rev_second) = r.proposed("Quantize");
    let vague = r.say("ok, add it");
    // Only the latest proposal can be taken from a vague answer.
    assert!(matches!(
        r.tasks.admit(r.project(), &r.general, &first, &vague.id, rev_first),
        Err(TaskError::Stale(text)) if text.contains("more recently")
    ));
    r.tasks
        .admit(r.project(), &r.general, &second, &vague.id, rev_second)
        .unwrap();
    // Naming the Task (attaching it) makes an earlier proposal answerable.
    let named = r.say_about("The pruning one, please", &[&first]);
    r.tasks
        .admit(r.project(), &r.general, &first, &named.id, rev_first)
        .unwrap();
    assert_eq!(r.tasks.board(r.project()).unwrap().total, 2);
}

#[test]
fn only_the_general_agents_top_level_proposal_counts_as_showing_a_brief() {
    let r = rig();
    // A draft nobody showed, with a citation planted by a specialist in General.
    let (question, _) =
        r.f.research
            .create_authored(
                r.project(),
                brief("Unshown"),
                None,
                AuthorKind::Agent,
                Some(&r.specialist),
            )
            .unwrap();
    let channel = r.channels.default_channel(r.project()).unwrap();
    let planted = ContextRef::at(ContextKind::Research, &question.id, "1");
    r.channels
        .post(
            r.project(),
            &channel.id,
            NewMessage {
                body: "Look at this one",
                author_kind: Some(MessageAuthor::Agent),
                author_ref: Some(&r.specialist),
                references: std::slice::from_ref(&planted),
                client_message_id: Some("planted"),
                ..Default::default()
            },
        )
        .unwrap();
    let instruction = r.say_about("Add it", &[&question.id]);
    let attempt = r
        .tasks
        .admit(r.project(), &r.general, &question.id, &instruction.id, 1);
    assert!(
        matches!(attempt, Err(TaskError::Stale(text)) if text.contains("never shown")),
        "{attempt:?}"
    );
}

#[test]
fn execution_runs_once_after_a_newer_instruction_and_a_retry_is_checked_again() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    let go = r.say("Go ahead");
    let (execution, _) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();

    // A second instruction while it runs makes no second round.
    let again = r.say("Run it again, please");
    let second = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &again.id);
    assert!(
        matches!(second, Err(TaskError::State(text)) if text.contains("already executing")),
        "{second:?}"
    );
    assert_eq!(r.f.research.rounds(r.project(), &id).unwrap().len(), 1);

    // After it is accepted, an old unused instruction cannot reopen it.
    let old = r.say("Maybe later we should try more");
    r.tasks
        .request_review(r.project(), &r.general, &id, "done", &[])
        .unwrap();
    let request = r.tasks.review_requests(r.project(), &id).unwrap().remove(0);
    r.tasks
        .review(
            r.project(),
            &id,
            &request.id,
            true,
            WorkOutcome::Supported,
            None,
        )
        .unwrap();
    let stale = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &old.id);
    assert!(matches!(stale, Err(TaskError::Stale(_))), "{stale:?}");
    assert_eq!(
        r.f.research.get(r.project(), &id).unwrap().status,
        ResearchStatus::Resolved
    );
    let fresh = r.say("Let's iterate");
    r.tasks
        .start_execution(r.project(), &r.general, &id, &fresh.id)
        .unwrap();
    assert_eq!(r.f.research.rounds(r.project(), &id).unwrap().len(), 2);
    let _ = execution;
}

#[test]
fn a_crash_between_the_record_and_the_round_is_finished_by_repeating_the_instruction_unless_the_brief_moved()
 {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    let go = r.say("Go ahead");
    let (done, _) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    // Roll the world back to just after the authorization was recorded.
    {
        let database = r.f.agents.database();
        let connection = database.lock().unwrap();
        connection
            .execute(
                "UPDATE task_authorizations SET round_id = NULL WHERE id = ?1",
                [&done.id],
            )
            .unwrap();
    }
    let (finished, created) = r
        .tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    assert!(!created);
    assert_eq!(
        finished.round_id, done.round_id,
        "the same round, not a second one"
    );
    assert_eq!(r.f.research.rounds(r.project(), &id).unwrap().len(), 1);

    // If the brief moved before the retry, the stale instruction is not honoured.
    let (id2, rev2, instruction2) = r.instructed("Quantize");
    r.tasks
        .admit(r.project(), &r.general, &id2, &instruction2.id, rev2)
        .unwrap();
    let go2 = r.say("Run quantize");
    let (record, _) = r
        .tasks
        .start_execution(r.project(), &r.general, &id2, &go2.id)
        .unwrap();
    {
        let database = r.f.agents.database();
        database
            .lock()
            .unwrap()
            .execute(
                "UPDATE task_authorizations SET round_id = NULL WHERE id = ?1",
                [&record.id],
            )
            .unwrap();
    }
    r.tasks
        .revise(
            r.project(),
            &r.general,
            &id2,
            1,
            &BriefPatch {
                question: Some("Something quite different".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let retried = r
        .tasks
        .start_execution(r.project(), &r.general, &id2, &go2.id);
    assert!(matches!(retried, Err(TaskError::State(_))), "{retried:?}");
}

#[test]
fn only_the_manager_refines_starts_approves_and_asks_for_review() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    r.tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    let go = r.say("Go");
    let patch = BriefPatch::default();
    assert!(matches!(
        r.tasks
            .revise(r.project(), &r.specialist, &id, 1, &patch, None),
        Err(TaskError::NotManager)
    ));
    assert!(matches!(
        r.tasks
            .start_execution(r.project(), &r.specialist, &id, &go.id),
        Err(TaskError::NotManager)
    ));
    assert!(matches!(
        r.tasks
            .approve_revision(r.project(), &r.specialist, &id, &go.id, 1),
        Err(TaskError::NotManager)
    ));
    assert!(matches!(
        r.tasks
            .request_review(r.project(), &r.specialist, &id, "x", &[]),
        Err(TaskError::NotManager)
    ));
    assert!(matches!(
        r.tasks.show_again(r.project(), &r.specialist, &id),
        Err(TaskError::NotManager)
    ));
    // Review needs a running Task and well-formed evidence.
    assert!(matches!(
        r.tasks.request_review(r.project(), &r.general, &id, "not started yet", &[]),
        Err(TaskError::State(text)) if text.contains("executing")
    ));
    r.tasks
        .start_execution(r.project(), &r.general, &id, &go.id)
        .unwrap();
    assert!(matches!(
        r.tasks.request_review(
            r.project(),
            &r.general,
            &id,
            "done",
            &["not-a-reference".into()]
        ),
        Err(TaskError::Invalid(_))
    ));
}

#[test]
fn authorizations_survive_a_restart_and_racing_callers_get_one_record() {
    let r = rig();
    let (id, revision, instruction) = r.instructed("Prune heads");
    let (admission, _) = r
        .tasks
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    // A new store over the same database is the same Task.
    let restarted = TaskStore::from_database(
        r.f.agents.database(),
        Arc::clone(&r.f.agents),
        Arc::clone(&r.f.research),
        Arc::clone(&r.channels),
        Arc::clone(&r.tasks.members),
        Arc::clone(&r.work),
    )
    .unwrap();
    let (again, created) = restarted
        .admit(r.project(), &r.general, &id, &instruction.id, revision)
        .unwrap();
    assert!((again.id.as_str(), created) == (admission.id.as_str(), false));
    assert_eq!(restarted.board(r.project()).unwrap().total, 1);

    // Two callers racing with the same instruction: one record, no 500.
    let (other, rev) = r.proposed("Quantize");
    let go = r.say("Add quantize");
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| r.tasks.admit(r.project(), &r.general, &other, &go.id, rev)))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert!(results.iter().all(|result| result.is_ok()), "{results:?}");
    let ids: std::collections::HashSet<String> = results
        .iter()
        .map(|result| result.as_ref().unwrap().0.id.clone())
        .collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result.as_ref().unwrap().1)
            .count(),
        1
    );
}

#[test]
fn a_resolved_question_with_a_started_round_is_done_and_the_first_round_is_recorded() {
    let r = rig();
    r.f.research
        .round_mark_started(r.project(), &r.f.research_id, &r.f.round_id)
        .unwrap();
    r.f.research
        .set_status(r.project(), &r.f.research_id, ResearchStatus::Resolved)
        .unwrap();
    // A second round, started later.
    let (second, _) =
        r.f.research
            .begin_round(
                r.project(),
                &r.f.research_id,
                crate::research_store::NewRound {
                    kind: crate::research_store::RoundKind::Solo,
                    idempotency_key: "r2",
                    expected_revision: 1,
                    request: serde_json::json!({}),
                    sources: Vec::new(),
                },
            )
            .unwrap();
    r.f.research
        .round_mark_started(r.project(), &r.f.research_id, &second.id)
        .unwrap();
    let card = r.tasks.card(r.project(), &r.f.research_id).unwrap();
    assert!(
        card.is_none(),
        "not adopted until it is read through the board"
    );
    let board = r.tasks.board(r.project()).unwrap();
    let card = board
        .cards
        .iter()
        .find(|c| c.id == r.f.research_id)
        .unwrap();
    // The researcher resolved it, so it is finished; both rounds and the first one's record are kept.
    assert_eq!(card.stage, TaskStage::Done);
    assert_eq!(
        r.tasks.board(r.project()).unwrap().cards[0].stage,
        TaskStage::Done,
        "reading again changes nothing"
    );
    let admission = r
        .tasks
        .admission(r.project(), &r.f.research_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        admission.round_id.as_deref(),
        Some(r.f.round_id.as_str()),
        "the first round"
    );
    assert_eq!(card.rounds.len(), 2);
}
