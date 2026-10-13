import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import { runtime } from './runtime.js'
import { createMinimalNotesPreset } from '../../presets/minimal-notes.js'
import { resolveConfig } from '../../src/config.js'

/** Exercise native preset inheritance, child lifecycle and session-scoped notes. */
export async function subagentRuntime(respond) {
  const rt = await runtime(respond, { mountScroll: false, systemPrompt: { includeRuntimeContext: true } })
  try {
    let failure
    rt.ctx.on('agent/error', ({ error }) => { failure ??= error })
    rt.ctx.baseUrl = new URL('../../', import.meta.url).href
    await rt.ctx.plugin(Loader, { baseUrl: new URL('../../', import.meta.url).href })
    rt.ctx.loader.builtins.group = Group
    await rt.ctx.plugin(PresetRegistry, { default: 'minimal-notes' })
    await rt.ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await rt.ctx.plugin(Subprocess)
    await rt.ctx.plugin(Sandbox)
    await rt.ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: rt.root })
    await rt.ctx.plugin(Approval, { policy: 'ask' })
    await rt.ctx.plugin(Subagents)
    await rt.ctx.plugin(Spawn, { providerName: 'spawn' })
    await rt.ctx.agentPresets.register(createMinimalNotesPreset(resolveConfig()))
    const handle = await rt.ctx.agents.create({
      sessionId: 'notes-parent',
      meta: { cwd: rt.root, agentPreset: 'minimal-notes' },
      agentOptions: { provider: 'scripted', model: 'offline' },
      setup: async ctx => { await rt.ctx.agentPresets.mount(ctx, 'minimal-notes') },
    })
    return {
      ...rt,
      parent: handle.agent,
      async run(agent, message) {
        const events = await rt.run(agent, message)
        if (failure) throw failure
        return events
      },
    }
  } catch (error) {
    await rt.close()
    throw error
  }
}
