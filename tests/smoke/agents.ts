import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, type APIRequestContext } from '@playwright/test'

/**
 * Deterministic stand-ins for the members of a Workspace (ADR 0225).
 *
 * The fixture provider (`scripts/fixtures/playwright-opencode`) records the MCP
 * servers the runtime hands to each Session and the prompts that reach it. A
 * test reads those, waits for a member's Session to be prompted by the real
 * routing, and then acts *as that member* through the same authenticated MCP
 * endpoint a real agent would use. Everything a member does therefore goes
 * through the production tools, authority checks, and stores; nothing is
 * stubbed. What this does not cover is a real model's judgement: that needs a
 * real provider and is validated separately, by hand.
 */
export function fixtureDirectory(): string {
  const port = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:41741').port || '41741'
  return join(process.cwd(), '.local', `playwright-fixtures-${port}`)
}

type Recorded = { conversationId: string; url: string; prompts: string[] }

function read(directory: string): Recorded[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const recorded: Recorded[] = []
  for (const name of names.filter((entry) => /^session-\d+\.json$/.test(entry))) {
    const pid = /\d+/.exec(name)?.[0] ?? ''
    let session: { params?: { mcpServers?: Array<{ name: string; url?: string }> } }
    try {
      session = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    } catch {
      continue
    }
    const work = (session.params?.mcpServers ?? []).find((server) => server.name === 'kubecode-work')
    if (!work?.url) continue
    const conversationId = work.url.split('/').pop() ?? ''
    let prompts: string[] = []
    try {
      prompts = readFileSync(join(directory, `prompts-${pid}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { params?: { prompt?: Array<{ text?: string }> } }
          return (entry.params?.prompt ?? []).map((part) => part.text ?? '').join('\n')
        })
    } catch {
      // No prompt yet.
    }
    recorded.push({ conversationId, url: work.url, prompts })
  }
  return recorded
}

/** Every prompt that reached a Session, oldest process first. */
export function promptsOf(conversationId: string): string[] {
  return read(fixtureDirectory())
    .filter((entry) => entry.conversationId === conversationId)
    .flatMap((entry) => entry.prompts)
}

/** Waits until a Session was prompted with text satisfying `matches`, and returns that text. */
export async function waitForPrompt(conversationId: string, matches: (text: string) => boolean): Promise<string> {
  let found = ''
  await expect.poll(() => {
    found = promptsOf(conversationId).find(matches) ?? ''
    return found
  }, { timeout: 30_000, message: 'the member was not prompted' }).not.toBe('')
  return found
}

function urlOf(conversationId: string): string {
  const entry = read(fixtureDirectory()).find((candidate) => candidate.conversationId === conversationId)
  if (!entry) throw new Error('that member has not been prompted yet, so it has no tools')
  return entry.url
}

const HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
}

type Rpc = { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } }

/** The reply is JSON or a single server-sent event carrying the JSON. */
function parseRpc(text: string): Rpc {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Rpc
  const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
  const json = data.find((entry) => entry.startsWith('{'))
  if (!json) throw new Error(`no JSON in the MCP reply: ${trimmed.slice(0, 200)}`)
  return JSON.parse(json) as Rpc
}

/** One member acting through its own MCP endpoint. */
export class MemberAgent {
  private session: string | null = null
  private counter = 0

  constructor(private readonly request: APIRequestContext, private readonly conversationId: string) {}

  private async post(body: Record<string, unknown>) {
    const headers: Record<string, string> = { ...HEADERS }
    if (this.session) headers['mcp-session-id'] = this.session
    return this.request.post(urlOf(this.conversationId), { data: body, headers })
  }

  private async open() {
    if (this.session) return
    const response = await this.post({
      jsonrpc: '2.0',
      id: ++this.counter,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture-member', version: '1' } },
    })
    expect(response.ok(), await response.text()).toBe(true)
    this.session = response.headers()['mcp-session-id'] ?? null
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /** Calls a tool; a refusal throws with the server's words. */
  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.open()
    const response = await this.post({
      jsonrpc: '2.0',
      id: ++this.counter,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    })
    expect(response.ok(), await response.text()).toBe(true)
    const body = parseRpc(await response.text())
    if (body.error) throw new Error(body.error.message ?? 'tool error')
    const text = body.result?.content?.[0]?.text ?? ''
    if (body.result?.isError) throw new Error(text)
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Calls a tool that must be refused, and returns the refusal. */
  async refused(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.call(tool, args)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error(`${tool} was expected to be refused`)
  }
}
