import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { KubecodeApi, Project } from '../api'
import { ProjectDialog } from './ProjectDialog'

const t = ((key: string) => key) as never

describe('ProjectDialog', () => {
  it('says where a new Workspace leads, and hands the registered Workspace on', async () => {
    const project = { id: 'p1', name: 'study', path: '/tmp/study' } as Project
    const api = {
      listDirectories: vi.fn().mockResolvedValue({ path: '/tmp', parent: '/', entries: [] }),
      createProject: vi.fn().mockResolvedValue(project),
      importProject: vi.fn(),
    } as unknown as KubecodeApi
    const onProject = vi.fn()
    const onOpenChange = vi.fn()
    render(<ProjectDialog api={api} open t={t} onOpenChange={onOpenChange} onProject={onProject} />)
    expect(screen.getByText('kubecode.projectDialog.next')).toBeInTheDocument()
    const input = screen.getByRole('combobox', { name: 'kubecode.projectPath' })
    await waitFor(() => expect(input).toHaveValue('/tmp/'))
    fireEvent.change(input, { target: { value: '/tmp/study' } })
    fireEvent.click(await screen.findByRole('option', { name: /kubecode\.create \/tmp\/study/ }))
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(project))
    expect(api.createProject).toHaveBeenCalledWith('/tmp/study')
    expect(api.importProject).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('switches between creating and registering as one choice', async () => {
    const api = {
      listDirectories: vi.fn().mockResolvedValue({ path: '/tmp', parent: '/', entries: [] }),
    } as unknown as KubecodeApi
    render(<ProjectDialog api={api} open t={t} onOpenChange={vi.fn()} onProject={vi.fn()} />)
    const create = screen.getByRole('radio', { name: 'kubecode.createProject' })
    expect(create).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'kubecode.importProject' }))
    expect(screen.getByRole('heading', { name: 'kubecode.importProject' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'kubecode.importProject' })).toHaveAttribute('aria-checked', 'true')
  })

  it('reports a directory that cannot be listed as an alert', async () => {
    const api = {
      listDirectories: vi.fn().mockRejectedValue(new Error('Permission denied')),
    } as unknown as KubecodeApi
    render(<ProjectDialog api={api} open t={t} onOpenChange={vi.fn()} onProject={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Permission denied')
    expect(alert.closest('[data-slot="alert"]') ?? alert).toHaveAttribute('data-slot', 'alert')
  })
})
