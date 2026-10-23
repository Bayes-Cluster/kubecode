import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'

import type { Conversation, TeamSnapshot } from '../api'
import { SessionTitlebar } from './SessionTitlebar'

const conversation = { id: 's1', agent_id: 'codex', title: 'Work' } as unknown as Conversation
const team = {
  team: { id: 'team-1', status: 'active', title: 'Team' },
  members: [],
  summary: { needs_attention: 0 },
} as unknown as TeamSnapshot

function renderBar(props: Partial<Parameters<typeof SessionTitlebar>[0]> = {}) {
  const onTeamViewChange = vi.fn()
  render(<SessionTitlebar
    active={false}
    canFork={false}
    conversation={conversation}
    leaderReviewPending={false}
    locale="de-DE"
    onForkSession={vi.fn()}
    onPromoteToTeam={vi.fn()}
    onRename={vi.fn()}
    onRequestDelete={vi.fn()}
    onRestoreAgentTitle={vi.fn()}
    onTeamViewChange={onTeamViewChange}
    pendingElicitation={false}
    t={createTranslator('de-DE')}
    team={null}
    teamView="chat"
    usage={null}
    waitingForInput={false}
    {...props}
  />)
  return { onTeamViewChange }
}

describe('SessionTitlebar', () => {
  it('announces only the translated running label, not an untranslated spinner status', () => {
    renderBar({ active: true })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByLabelText('Loading')).toBeNull()
  })

  it('switches Chat/Team without pointing at tab panels that do not exist', () => {
    const { onTeamViewChange } = renderBar({ team, teamView: 'chat' })
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    for (const element of document.querySelectorAll('[aria-controls]')) {
      expect(document.getElementById(element.getAttribute('aria-controls') ?? '')).not.toBeNull()
    }
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(radios[1])
    expect(onTeamViewChange).toHaveBeenCalledWith('team')
  })
})
