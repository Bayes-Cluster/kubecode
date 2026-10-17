import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTranslator } from '@/lib/i18n'
import { trackEvent } from '@/lib/telemetry'

import { ApiError } from './api'
import type { IlinkConnectionStatus, IlinkStatus, KubecodeApi, WorkspaceEvent } from './api'
import { WeChatSettingsPanel } from './app/WeChatSettingsPanel'
import { WECHAT_LOGIN_POLL_MS } from './app/wechatStatus'

vi.mock('@/lib/telemetry', () => ({ trackEvent: vi.fn() }))

const t = createTranslator('en')
const QR = 'data:image/svg+xml;base64,PHN2Zy8+'
const ACCOUNT_ID = 'ilink_bot_synthetic_private_id'

function status(value: IlinkConnectionStatus, overrides: Partial<IlinkStatus> = {}): IlinkStatus {
  const loginActive = ['requesting_qr', 'waiting_for_scan', 'scanned', 'verification_required', 'redirecting']
    .includes(value)
  return {
    status: value,
    account_id: null,
    display_name: null,
    bound_conversation_id: null,
    login_active: loginActive,
    login_expires_in_ms: loginActive ? 240_000 : null,
    login_generation: loginActive ? 3 : null,
    ...overrides,
  }
}

function linked(value: IlinkConnectionStatus): IlinkStatus {
  return status(value, { account_id: ACCOUNT_ID, display_name: 'Ops Bot' })
}

function wechatApi(overrides: Record<string, unknown> = {}) {
  return {
    ilinkStatus: vi.fn().mockResolvedValue(status('disconnected')),
    ilinkPollLogin: vi.fn().mockResolvedValue({ ...status('disconnected'), qr_svg: null }),
    ilinkStartLogin: vi.fn(),
    ilinkVerify: vi.fn().mockResolvedValue(undefined),
    ilinkCancelLogin: vi.fn().mockResolvedValue(undefined),
    ilinkReconnect: vi.fn().mockResolvedValue(undefined),
    ilinkDisconnect: vi.fn().mockResolvedValue(undefined),
    ilinkQuickPrompts: vi.fn().mockResolvedValue({ slots: 9, max_chars: 2000, prompts: [] }),
    ilinkSetQuickPrompt: vi.fn().mockResolvedValue(undefined),
    ilinkRemoveQuickPrompt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderPanel(api: ReturnType<typeof wechatApi>, events: WorkspaceEvent[] = []) {
  return render(
    <WeChatSettingsPanel api={api as unknown as KubecodeApi} t={t} workspaceEvents={events} />,
  )
}

function statusEvent(id: number): WorkspaceEvent {
  return {
    id,
    kind: 'ilink_status_changed',
    project_id: null,
    conversation_id: null,
    run_id: null,
    payload: { status: 'connected' },
    created_at: '',
  }
}

/** The live status region once it shows `text` (the loading node is reused). */
async function statusRegion(text: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text))
  return screen.getByRole('status')
}

beforeEach(() => {
  vi.mocked(trackEvent).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WeChatSettingsPanel', () => {
  it.each([
    ['disconnected', 'Not connected', 'Connect WeChat'],
    ['requesting_qr', 'Requesting a QR code', 'Cancel login'],
    ['waiting_for_scan', 'Waiting for scan', 'Cancel login'],
    ['scanned', 'Scanned', 'Cancel login'],
    ['verification_required', 'Verification required', 'Submit code'],
    ['verification_blocked', 'Verification blocked', 'New QR code'],
    ['redirecting', 'Redirecting', 'Cancel login'],
    ['connected', 'Connected', 'Disconnect'],
    ['backing_off', 'Reconnecting', 'Reconnect'],
    ['expired', 'Login expired', 'New QR code'],
    ['error', 'Connection error', 'Reconnect'],
  ] as const)('renders the %s state with its action', async (value, label, action) => {
    const loginActive = ['requesting_qr', 'waiting_for_scan', 'scanned', 'verification_required', 'redirecting']
      .includes(value)
    const current = value === 'disconnected' ? status(value) : linked(value)
    const api = wechatApi({
      ilinkStatus: vi.fn().mockResolvedValue(current),
      ilinkPollLogin: vi.fn().mockResolvedValue({ ...current, qr_svg: loginActive ? QR : null }),
    })
    renderPanel(api)
    const region = await statusRegion(label)
    expect(region).toHaveTextContent(t(`kubecode.wechat.statusDescription.${value}`))
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument()
    if (loginActive) {
      expect(screen.getByRole('img', { name: 'QR code for linking WeChat to Kubecode' }))
        .toHaveAttribute('src', QR)
      expect(screen.getByText(/Open WeChat, tap \+ and then Scan/)).toBeInTheDocument()
    } else {
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
    }
    // Account identifiers never reach the DOM; only the display name does.
    expect(document.body.innerHTML).not.toContain(ACCOUNT_ID)
  })

  it('connects, polls only the login, verifies against the live generation, and converges', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const ilinkStatus = vi.fn()
      .mockResolvedValueOnce(status('disconnected'))
      .mockResolvedValue({ ...status('waiting_for_scan'), login_generation: 7 })
    const ilinkPollLogin = vi.fn()
      .mockResolvedValueOnce({ ...status('waiting_for_scan'), login_generation: 7, qr_svg: QR })
      .mockResolvedValueOnce({ ...status('scanned'), login_generation: 7, qr_svg: QR })
      .mockResolvedValue({ ...status('verification_required'), login_generation: 7, qr_svg: QR })
    const api = wechatApi({
      ilinkStatus,
      ilinkPollLogin,
      ilinkStartLogin: vi.fn().mockResolvedValue({
        reused: false,
        qr_svg: QR,
        expires_in_ms: 300_000,
        generation: 7,
        status: 'waiting_for_scan',
      }),
    })
    renderPanel(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect WeChat' }))
    expect(await screen.findByRole('img', { name: /QR code/ })).toHaveAttribute('src', QR)
    expect(api.ilinkStartLogin).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Expires in about 4 min')).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(WECHAT_LOGIN_POLL_MS) })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Scanned'))
    await act(async () => { await vi.advanceTimersByTimeAsync(WECHAT_LOGIN_POLL_MS) })
    const input = await screen.findByLabelText('Verification code')
    const submit = screen.getByRole('button', { name: 'Submit code' })
    expect(submit).toBeDisabled()
    fireEvent.change(input, { target: { value: ' 4829 ' } })
    fireEvent.click(submit)
    await waitFor(() => expect(api.ilinkVerify).toHaveBeenCalledWith('4829', 7))
    expect(trackEvent).toHaveBeenCalledWith('kubecode_wechat_action', { action: 'verify', result: 'ok' })
  })

  it('rejects a code for a stale QR generation with a recoverable message', async () => {
    const current = { ...status('verification_required'), login_generation: 2 }
    const api = wechatApi({
      ilinkStatus: vi.fn().mockResolvedValue(current),
      ilinkPollLogin: vi.fn().mockResolvedValue({ ...current, qr_svg: QR }),
      ilinkVerify: vi.fn().mockRejectedValue(
        new ApiError('ilink_invalid_state', 'invalid state: stale login generation', 409),
      ),
    })
    renderPanel(api)
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '1111' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('belongs to an earlier QR code')
    expect(api.ilinkVerify).toHaveBeenCalledWith('1111', 2)
    // The raw server message is never shown.
    expect(document.body.innerHTML).not.toContain('stale login generation')
    expect(trackEvent).toHaveBeenCalledWith('kubecode_wechat_action', { action: 'verify', result: 'error' })
  })

  it('cancels a login and retries a backing-off connection, explaining cooldowns', async () => {
    const api = wechatApi({
      ilinkStatus: vi.fn()
        .mockResolvedValueOnce(status('waiting_for_scan'))
        .mockResolvedValue(linked('backing_off')),
      ilinkPollLogin: vi.fn().mockResolvedValue({ ...status('waiting_for_scan'), qr_svg: QR }),
      ilinkReconnect: vi.fn()
        .mockRejectedValueOnce(new ApiError('ilink_cooldown_active', 'cooldown 12s', 409))
        .mockResolvedValue(undefined),
    })
    renderPanel(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel login' }))
    await waitFor(() => expect(api.ilinkCancelLogin).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait a moment before reconnecting.')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(api.ilinkReconnect).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('confirms before disconnecting and removing credentials', async () => {
    const api = wechatApi({ ilinkStatus: vi.fn().mockResolvedValue(linked('connected')) })
    renderPanel(api)
    expect(await screen.findByText('Account: Ops Bot')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect WeChat?' })
    expect(dialog).toHaveTextContent('Sessions and Project files are not changed.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.ilinkDisconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect and remove' }))
    await waitFor(() => expect(api.ilinkDisconnect).toHaveBeenCalledTimes(1))
    expect(trackEvent).toHaveBeenCalledWith('kubecode_wechat_action', { action: 'disconnect', result: 'ok' })
  })

  it('converges on ilink_status_changed events and ignores out-of-order responses', async () => {
    let finishFirst: (value: IlinkStatus) => void = () => undefined
    const ilinkStatus = vi.fn()
      .mockImplementationOnce(() => new Promise<IlinkStatus>((resolve) => { finishFirst = resolve }))
      .mockResolvedValue(linked('connected'))
    const api = wechatApi({ ilinkStatus })
    const { rerender } = renderPanel(api)
    rerender(
      <WeChatSettingsPanel api={api as unknown as KubecodeApi} t={t} workspaceEvents={[statusEvent(5)]} />,
    )
    await statusRegion('Connected')
    // The superseded first response lands late and must not win.
    await act(async () => { finishFirst(status('disconnected')) })
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
    // The same event is processed once.
    rerender(
      <WeChatSettingsPanel api={api as unknown as KubecodeApi} t={t} workspaceEvents={[statusEvent(5)]} />,
    )
    expect(ilinkStatus).toHaveBeenCalledTimes(2)
  })

  it('recovers from a failed status load', async () => {
    const api = wechatApi({
      ilinkStatus: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(status('disconnected')),
    })
    renderPanel(api)
    expect(await screen.findByRole('alert')).toHaveTextContent('WeChat status is unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await statusRegion('Not connected')
  })

  it('emits only categorical telemetry', async () => {
    const api = wechatApi({
      ilinkStartLogin: vi.fn().mockResolvedValue({
        reused: false, qr_svg: QR, expires_in_ms: 1, generation: 1, status: 'waiting_for_scan',
      }),
    })
    renderPanel(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect WeChat' }))
    await waitFor(() => expect(trackEvent).toHaveBeenCalled())
    for (const [name, properties] of vi.mocked(trackEvent).mock.calls) {
      expect(name).toMatch(/^kubecode_wechat_/)
      expect(Object.keys(properties ?? {}).sort()).toEqual(['action', 'result'])
      expect(JSON.stringify(properties)).not.toContain('svg')
    }
  })

  it('edits quick prompts for a linked account', async () => {
    const api = wechatApi({
      ilinkStatus: vi.fn().mockResolvedValue(linked('connected')),
      ilinkQuickPrompts: vi.fn()
        .mockResolvedValueOnce({ slots: 9, max_chars: 2000, prompts: [{ slot: 1, content: 'Run tests' }] })
        .mockResolvedValue({ slots: 9, max_chars: 2000, prompts: [
          { slot: 1, content: 'Run tests' },
          { slot: 2, content: 'Summarize PRs' },
        ] }),
    })
    renderPanel(api)
    expect(await screen.findByLabelText('Quick prompt 1')).toHaveValue('Run tests')
    fireEvent.change(screen.getByLabelText('Quick prompt 2'), { target: { value: 'Summarize PRs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(api.ilinkSetQuickPrompt).toHaveBeenCalledWith(2, 'Summarize PRs'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove quick prompt 1' }))
    await waitFor(() => expect(api.ilinkRemoveQuickPrompt).toHaveBeenCalledWith(1))
    expect(trackEvent).toHaveBeenCalledWith('kubecode_wechat_quick_prompt_changed', { action: 'remove' })
  })
})

describe('WeChat quick prompt editing failures', () => {
  it('keeps the draft and the error when a save fails', async () => {
    const api = wechatApi({
      ilinkStatus: vi.fn().mockResolvedValue(linked('connected')),
      ilinkQuickPrompts: vi.fn().mockResolvedValue({
        slots: 9,
        max_chars: 2000,
        prompts: [{ slot: 1, content: 'Run tests' }],
      }),
      ilinkSetQuickPrompt: vi.fn().mockRejectedValue(new Error('offline')),
      ilinkRemoveQuickPrompt: vi.fn().mockRejectedValue(new Error('offline')),
    })
    renderPanel(api)
    const field = await screen.findByLabelText('Quick prompt 1')
    fireEvent.change(field, { target: { value: 'Run all tests' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The WeChat request failed.')
    expect(screen.getByLabelText('Quick prompt 1')).toHaveValue('Run all tests')
    fireEvent.click(screen.getByRole('button', { name: 'Remove quick prompt 1' }))
    await waitFor(() => expect(api.ilinkRemoveQuickPrompt).toHaveBeenCalledWith(1))
    expect(screen.getByLabelText('Quick prompt 1')).toHaveValue('Run all tests')
    expect(api.ilinkQuickPrompts).toHaveBeenCalledTimes(1)
    expect(trackEvent).not.toHaveBeenCalledWith('kubecode_wechat_quick_prompt_changed', expect.anything())
  })
})
