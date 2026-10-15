import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runtime, call, text, lastTool, toolText, replacementEvents } from './support/runtime.js'
import { subagentRuntime } from './support/subagents.js'

const config = { contextBudgetTokens: 4096, reminderTokens: 512 }
const input = 'SOFT_TARGET_ORIGINAL_INPUT ' + 'x'.repeat(80000)
const completed = events => assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')

async function eventsOf(rt, agent) {
  await rt.ctx.sessions.flush(agent.session)
  const handle = await rt.ctx.sessionPersistence.open(agent.session.id, 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}

function untilAborted(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('requests far above the soft target preserve caller maxTokens and execute normal task tools', async () => {
  const maxTokens = 8192
  const artifactText = 'Native task execution remains available above the soft working target.'
  let executed = 0
  const r = await runtime((options, step, ctx) => {
    assert.equal(options.maxTokens, maxTokens)
    assert.ok(ctx.tokenMeter.measure(ctx.sessions.get(options.sessionId)).totalTokens > config.contextBudgetTokens * 2)
    assert.equal(options.messages.filter(message => message.content.some(block => block.type === 'text' && block.text === input)).length, 1)
    switch (step) {
      case 0: return [call('get_context_remaining')]
      case 1: {
        assert.notEqual(lastTool(options).isError, true)
        const status = JSON.parse(toolText(lastTool(options)))
        assert.deepEqual(Object.keys(status).sort(), [
          'tokens_left', 'used_tokens', 'budget_tokens', 'reminder_threshold_tokens', 'over_budget', 'soft_limit', 'baseline',
        ].sort())
        assert.equal(status.tokens_left, 0)
        assert.ok(status.used_tokens > config.contextBudgetTokens * 2)
        assert.equal(status.budget_tokens, config.contextBudgetTokens)
        assert.equal(status.reminder_threshold_tokens, config.contextBudgetTokens - config.reminderTokens)
        assert.equal(status.over_budget, true)
        assert.equal(status.soft_limit, true)
        assert.equal(typeof status.baseline, 'string')
        return [call('native_task_tool')]
      }
      default:
        assert.equal(step, 2)
        assert.notEqual(lastTool(options).isError, true)
        return [text('The task continued without a forced context reset.')]
    }
  }, { config, systemPrompt: { includeRuntimeContext: true } })
  try {
    const artifact = join(r.root, 'native-task.txt')
    r.ctx.tools.register({
      name: 'native_task_tool', description: 'Save a task artifact in the workspace.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [text(value)] },
      execute: async () => {
        executed++
        await writeFile(artifact, artifactText)
        return 'Native task artifact saved.'
      },
    })
    const agent = await r.ctx.agentLoop.create('soft-target-agent', { provider: 'scripted', model: 'offline', maxTokens }, { cwd: r.root })
    const events = await r.run(agent, input)
    completed(events)
    assert.equal(executed, 1)
    assert.equal(await readFile(artifact, 'utf8'), artifactText)
    assert.equal(r.requests.length, 3)
    assert.equal(agent.session.requestHeader().config.maxTokens, maxTokens)
    assert.equal(events.filter(event => event.type === 'tool/result' && event.data.message.isError).length, 0)
    assert.equal(replacementEvents(events).length, 0)
  } finally { await r.close() }
})

for (const parentState of ['working', 'idle']) {
  test(`native child messages and completion reach an over-target ${parentState} parent without rollover`, { timeout: 15000 }, async () => {
    const release = Promise.withResolvers()
    const relayQueued = Promise.withResolvers()
    const settlementQueued = Promise.withResolvers()
    const consumed = Promise.withResolvers()
    const relay = 'NATIVE_CHILD_RELAY_EVIDENCE'
    const result = 'NATIVE_CHILD_COMPLETED_RESULT'
    const seen = new Map()
    const endings = []
    let parentStep = 0
    let childStep = 0
    let childId
    const rt = await subagentRuntime(async options => {
      if (options.sessionId !== 'notes-parent') {
        if (childStep++ === 0) {
          await release.promise
          return [call('send_message', { agent_id: 'notes-parent', message: relay })]
        }
        assert.equal(childStep, 2)
        assert.notEqual(lastTool(options).isError, true)
        return [text(result)]
      }
      assert.ok(rt.ctx.tokenMeter.measure(rt.parent.session).totalTokens > config.contextBudgetTokens * 2)
      switch (parentStep++) {
        case 0: return [call('subagent', { description: 'native delivery probe', prompt: 'Send the assigned evidence to the parent, then finish.' })]
        case 1:
          childId = toolText(lastTool(options)).match(/started subagent (\S+)/)?.[1]
          assert.ok(childId, toolText(lastTool(options)))
          if (parentState === 'working') {
            release.resolve()
            await Promise.all([relayQueued.promise, settlementQueued.promise])
            return [call('get_context_remaining')]
          }
          return [text('Parent work is complete until the native child replies.')]
        default:
          for (const message of options.messages.filter(message => message.source?.senderSessionId === childId)) {
            if (message.source.kind === 'agent-message') {
              assert.match(toolText(message), new RegExp(relay))
              seen.set(message.id, message.source.kind)
            } else if (message.source.kind === 'subagent-settled') {
              assert.match(toolText(message), new RegExp(result))
              seen.set(message.id, message.source.kind)
            }
          }
          if ([...seen.values()].includes('agent-message') && [...seen.values()].includes('subagent-settled')) consumed.resolve()
          return [text('Parent consumed the native child input without resetting context.')]
      }
    }, config)
    rt.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== rt.parent) return
      if (message.source.kind === 'agent-message') relayQueued.resolve()
      if (message.source.kind === 'subagent-settled') settlementQueued.resolve()
    })
    rt.parent.ctx.on('subagent/end', info => { endings.push(info) })
    try {
      await rt.run(rt.parent, input)
      if (parentState === 'idle') {
        assert.equal(parentStep, 2)
        release.resolve()
      }
      await consumed.promise
      await rt.parent.whenIdle()
      const events = await eventsOf(rt, rt.parent)
      completed(events)
      assert.deepEqual([...seen.values()].sort(), ['agent-message', 'subagent-settled'])
      for (const kind of ['agent-message', 'subagent-settled']) {
        assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === kind
          && event.data.source.senderSessionId === childId).length, 1)
      }
      assert.equal(endings.length, 1)
      assert.equal(endings[0].id, childId)
      assert.equal(endings[0].stopReason, 'completed')
      assert.deepEqual(endings[0].lastAssistantMessage, [text(result)])
      assert.equal(childStep, 2)
      assert.equal((await rt.ctx.subagents.listChildren(rt.parent.session.id)).length, 1)
      assert.equal(replacementEvents(events).length, 0)
    } finally {
      release.resolve()
      await rt.close()
    }
  })
}

test('native interruption settles a child as aborted above the parent soft target', { timeout: 15000 }, async () => {
  const childStarted = Promise.withResolvers()
  const settlementQueued = Promise.withResolvers()
  const endings = []
  let parentStep = 0
  let childId
  const rt = await subagentRuntime(async options => {
    if (options.sessionId !== 'notes-parent') {
      childStarted.resolve()
      await untilAborted(options.signal)
      assert.fail('An interrupted child must not synthesize a successful completion.')
    }
    assert.ok(rt.ctx.tokenMeter.measure(rt.parent.session).totalTokens > config.contextBudgetTokens * 2)
    switch (parentStep++) {
      case 0: return [call('subagent', { description: 'native interruption probe', prompt: 'Wait for a parent interruption.' })]
      case 1:
        childId = toolText(lastTool(options)).match(/started subagent (\S+)/)?.[1]
        assert.ok(childId, toolText(lastTool(options)))
        await childStarted.promise
        return [call('interrupt_agent', { agent_id: childId })]
      case 2:
        assert.notEqual(lastTool(options).isError, true)
        await settlementQueued.promise
        return [call('get_context_remaining')]
      default: {
        assert.equal(parentStep, 4)
        const notices = options.messages.filter(message => message.source?.kind === 'subagent-settled' && message.source.senderSessionId === childId)
        assert.equal(notices.length, 1)
        return [text('The parent received the native aborted outcome.')]
      }
    }
  }, config)
  rt.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === rt.parent && message.source.kind === 'subagent-settled') settlementQueued.resolve()
  })
  rt.parent.ctx.on('subagent/end', info => { endings.push(info) })
  try {
    const events = await rt.run(rt.parent, input)
    completed(events)
    assert.equal(parentStep, 4)
    assert.equal(endings.length, 1)
    assert.equal(endings[0].id, childId)
    assert.equal(endings[0].stopReason, 'aborted')
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled'
      && event.data.source.senderSessionId === childId).length, 1)
    assert.equal(replacementEvents(events).length, 0)
  } finally { await rt.close() }
})
