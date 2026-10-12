import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as scroll from '../../src/index.js'

/** Script only the provider; use the published loop, tools, session and disk writer unchanged. */
export async function runtime(respond, { root, config = {}, systemPrompt = {}, mountScroll = true } = {}) {
  const ownRoot = !root
  root ??= await mkdtemp(join(tmpdir(), 'scroll-runtime-'))
  const requests = []
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Continue the active task using notes and history.', ...systemPrompt })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop)
  if (mountScroll) await ctx.plugin(scroll, config)
  class ScriptedAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const blocks = await respond(options, requests.length - 1, ctx)
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  return {
    ctx, root, requests,
    async create(id = 'scroll-agent') { return ctx.agentLoop.create(id, { provider: 'scripted', model: 'offline' }, { cwd: root }) },
    async run(agent, text) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
      const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
      try { return (await handle.read()).events } finally { await handle.close() }
    },
    async close() {
      await ctx.fiber.dispose()
      if (ownRoot) await rm(root, { recursive: true, force: true })
    },
  }
}

let id = 0
export const call = (name, args = {}) => ({ type: 'tool-call', id: `scroll-call-${++id}`, name, arguments: JSON.stringify(args) })
export const text = value => ({ type: 'text', text: value })
export const checkpoint = 'Goal: finish the active task.\nConstraints: preserve original evidence.\nVerified: prior work is recorded in history.\nNext: retrieve the original result and continue.\nEvidence: use scroll_history to locate exact event IDs.'
export const replacementEvents = events => events.filter(event => event.type === 'user/message' && event.data.source.kind === 'compaction-scroll-checkpoint')
export const lastTool = options => options.messages.findLast(message => message.role === 'tool')
export const toolText = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
