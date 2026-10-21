/**
 * Fixture content for the Workspace prototypes (ADR 0233). None of this comes
 * from a server: names, messages, runs and evidence are samples, written in
 * English. Interface text around them is localized.
 */
import type { MemberRoleKind } from '../MemberIdentity'
import type { MentionOption } from '../mentions'

export type FixtureMember = { id: string; name: string; handle: string; role: MemberRoleKind; responsibility: string }

export const FIXTURE_MEMBERS = {
  self: { id: 'mei', name: 'Mei Lin', handle: 'mei', role: 'researcher', responsibility: 'Researcher' },
  general: { id: 'general', name: 'General Agent', handle: 'general', role: 'manager', responsibility: 'Project manager' },
  ada: { id: 'ada', name: 'Ada', handle: 'ada', role: 'specialist', responsibility: 'Literature' },
  turing: { id: 'turing', name: 'Turing', handle: 'turing', role: 'specialist', responsibility: 'Experiments' },
  noether: { id: 'noether', name: 'Noether', handle: 'noether', role: 'specialist', responsibility: 'Analysis' },
} satisfies Record<string, FixtureMember>

export const FIXTURE_MENTIONS: MentionOption[] = Object.values(FIXTURE_MEMBERS)
  .filter((member) => member.id !== 'mei')
  .map((member) => ({
    id: member.id,
    handle: member.handle,
    label: member.name,
    identity: { role: member.role, roleLabel: member.responsibility },
  }))

export const FIXTURE_TASK_TITLE = 'RQ-2: Does sparse attention keep recall beyond 64k tokens?'

export const FIXTURE_REQUEST =
  '@general can you pull together what we know about sparse attention for long-context retrieval? Use my notes and the two papers I added yesterday.'

export const FIXTURE_RESEARCH = {
  intro:
    'Across the three sources, sparse attention keeps retrieval quality close to dense attention up to roughly 32k tokens, and the gap opens after that. The disagreement is mostly about how recall is measured, not about the mechanism.',
  findings: [
    'Sliding-window plus global tokens keeps recall@10 within two points of dense attention at 16k and 32k.',
    'Block-sparse patterns lose more on needle-style probes than on multi-document QA, because the needle often falls between blocks.',
    'Your notes record a 9-point drop at 64k for the windowed baseline; the papers do not test that length.',
  ],
  openQuestions:
    'None of the sources holds the tokenizer fixed across lengths, so part of the 64k drop may be truncation. RQ-2 is the natural place to test this with the three seeds you planned.',
  table: [
    ['Dense (baseline)', '16k–32k', '0.91', 'Your notes'],
    ['Sliding window + global', '16k–32k', '0.89', 'Longformer, 2020'],
    ['Block sparse', '32k', '0.84', 'BigBird, 2020'],
    ['Sliding window + global', '64k', '0.80', 'Your notes'],
  ],
}

export const FIXTURE_REFERENCES = {
  notes: { kind: 'file', title: 'notes/related-work.md', version: 'v3' },
  longformer: { kind: 'file', title: 'papers/longformer-2020.pdf' },
  bigbird: { kind: 'file', title: 'papers/bigbird-2020.pdf' },
  finding: { kind: 'finding', title: 'Recall drops 9 points at 64k (windowed)', version: 'v2' },
  dmNotes: { kind: 'discussion', title: 'Draft hypotheses with Ada' },
  recallTable: { kind: 'evidence', title: 'Recall@k by context length', version: 'v3' },
  ablation: { kind: 'evidence', title: 'Ablation: window size × seed', version: 'v2' },
  runLog: { kind: 'artifact', title: 'runs/rq2-seed-sweep.log' },
} as const

export const FIXTURE_TOOL = {
  launch: '{\n  "experiment": "rq2-seed-sweep",\n  "seeds": [1, 2, 3],\n  "context": [16384, 32768, 65536],\n  "gpus": 2\n}',
  loadOutput: 'Loaded 9 runs (3 seeds × 3 lengths). 0 missing, 0 failed.',
  failure: 'CUDA out of memory at context 65536, seed 2 (tried to allocate 3.1 GiB).',
}

export const FIXTURE_REVIEW = {
  brief:
    'Test whether sliding-window attention with global tokens keeps recall@10 within 3 points of dense attention at 64k tokens, with the tokenizer held fixed.',
  criteria: [
    'Three seeds per context length, tokenizer fixed.',
    'Recall@10 reported with a 95% interval.',
    'Truncation ruled out as the cause of any drop.',
  ],
  summary:
    'With the tokenizer fixed, the windowed model stays within 2.4 points of dense attention at 64k (0.88 vs 0.904). The earlier 9-point drop came from truncation in the old preprocessing.',
}
