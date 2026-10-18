import type {
  ExecutionEnvelope,
  ExperimentView,
  KubecodeApi,
  ResearchExecution,
  ResearchDetail,
  ResearchEntry,
  ResearchFinding,
  ResearchOutcome,
  ResearchProposal,
  ResearchRound,
} from '../api'

export const detailFixture: ResearchDetail = {
  id: 'rq-1',
  project_id: 'p1',
  status: 'open',
  archived: false,
  revision: 2,
  brief: {
    title: 'Pruning',
    question: 'Does structured pruning keep accuracy?',
    motivation: 'Cheaper inference',
    hypotheses: ['Late layers tolerate pruning'],
    constraints: ['single GPU'],
    evaluation_criteria: ['top-1 within one point'],
  },
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
  resolved_at: null,
  links: [
    {
      research_id: 'rq-1', kind: 'session', ref_id: 's-1', role: 'discussion',
      created_at: '', availability: 'available', title: 'Pruning chat', agent_id: 'codex', state: null,
    },
    {
      research_id: 'rq-1', kind: 'team', ref_id: 't-1', role: 'execution',
      created_at: '', availability: 'available', title: 'Pruning team', agent_id: null, state: 'completed',
    },
  ],
}

export const entryFixture: ResearchEntry = {
  id: 'e-1', research_id: 'rq-1', seq: 1, kind: 'note', author_kind: 'researcher',
  author_ref: null, body: 'Start with ResNet', brief_revision: 1, created_at: '',
}

export const findingFixture: ResearchFinding = {
  id: 'f-1',
  research_id: 'rq-1',
  publication_id: 'pub-1',
  seq: 1,
  kind: 'finding',
  basis: 'observation',
  statement: 'Accuracy held at 0.9',
  evidence: [{ kind: 'file', id: 'results.csv', revision: 'abc' }],
  evidence_state: [{ kind: 'file', id: 'results.csv', revision: 'abc', availability: 'changed' }],
  producer_state: [{ kind: 'team', id: 't-1', availability: 'available' }],
  author_kind: 'agent',
  author_ref: 'member-1',
  producer: { session_id: null, team_id: 't-1', task_id: null, run_id: null },
  round_id: 'round-1',
  brief_revision: 1,
  stale: true,
  created_at: '',
}

export const roundFixture: ResearchRound = {
  id: 'round-1',
  research_id: 'rq-1',
  round: 1,
  brief_revision: 1,
  stale: true,
  kind: 'team',
  phase: 'started',
  session: null,
  team: { id: 't-1', title: 'Pruning team', availability: 'available', state: 'completed' },
  request: { instruction: 'Compare approaches' },
  sources: [{ kind: 'session', id: 'gone', availability: 'removed' }],
  created_at: '',
  updated_at: '',
}

export const envelopeFixture: ExecutionEnvelope = {
  round_id: 'round-1',
  research_id: 'rq-1',
  revision: 2,
  state: 'active',
  limits: {
    max_launches: 4,
    max_concurrent: 2,
    deadline_at: null,
    max_runtime_secs: 1800,
    max_no_progress: 3,
    allowed_commands: [['python3', 'train.py'], ['bash', 'scripts/eval.sh']],
  },
  launches_reserved: 1,
  created_at: '',
  updated_at: '',
}

export function experimentFixture(overrides: Partial<ExperimentView> = {}): ExperimentView {
  return {
    id: 'x-1',
    project_id: 'p1',
    research_id: 'rq-1',
    round_id: 'round-1',
    team_id: 't-1',
    task_id: null,
    owner_member_id: 'member-1',
    launch_key: 'baseline',
    label: 'baseline',
    argv: ['python3', 'train.py', '--lr', '0.1'],
    cwd: '',
    artifacts: ['metrics.json'],
    sources: [],
    policy_revision: 2,
    max_runtime_secs: 1800,
    state: 'exited',
    analysis: 'pending',
    identity: null,
    exit_code: 0,
    signal: null,
    reason: null,
    cancel_requested: false,
    artifact_revisions: [{ path: 'metrics.json', revision: 'abc' }],
    created_at: '',
    launched_at: '',
    finished_at: '',
    artifact_state: [{ path: 'metrics.json', revision: 'abc', availability: 'changed' }],
    ...overrides,
  }
}

export function executionFixture(overrides: Partial<ResearchExecution> = {}): ResearchExecution {
  return {
    envelope: envelopeFixture,
    experiments: [experimentFixture()],
    waits: [],
    decisions: [],
    launch_blockers: [],
    now: 1_800_000_000,
    ...overrides,
  }
}

export function fakeApi(overrides: Partial<Record<keyof KubecodeApi, unknown>> = {}) {
  const api = {
    listResearch: async () => [],
    getResearch: async () => detailFixture,
    listResearchEntries: async () => [entryFixture],
    listResearchFindings: async () => [findingFixture],
    listResearchOutcomes: async (): Promise<ResearchOutcome[]> => [],
    listResearchProposals: async (): Promise<ResearchProposal[]> => [],
    listResearchRounds: async () => [roundFixture],
    getResearchExecution: async () => executionFixture(),
    ...overrides,
  }
  return api as unknown as KubecodeApi
}
