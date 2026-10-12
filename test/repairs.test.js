import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as scroll from '../src/index.js'
import { createMinimalNotesPreset } from '../presets/minimal-notes.js'
import { resolveConfig } from '../src/config.js'
import { runtime, call, text, checkpoint, replacementEvents } from './support/runtime.js'

const contains = (messages, value) => messages.filter(message => message.content.some(block => block.type === 'text' && block.text === value))
const success = events => assert.equal(events.at(-1).data.reason.kind, 'completed', JSON.stringify(events.at(-1)))

test('a refused fresh-window handoff does not block later user requests', async () => {
  const r = await runtime((_options, step) => step === 0
    ? [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    : step === 1 ? [call('new_context')] : [text('Continue without resetting until the budget is adjusted.')], {
    config: { contextBudgetTokens: 16000, reminderTokens: 15000 },
  })
  try {
    const agent = await r.create()
    const first = await r.run(agent, 'Continue the original task.')
    success(first)
    assert.equal(replacementEvents(first).length, 0)
    assert.equal(r.requests.length, 3)
    const second = await r.run(agent, 'Repair the handoff and continue.')
    success(second)
    assert.equal(r.requests.length, 4)
    assert.equal(contains(r.requests.at(-1).messages, 'Repair the handoff and continue.').length, 1)
  } finally { await r.close() }
})

test('budget-blocked input is delivered exactly once after restart with a larger budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scroll-repair-input-'))
  const rejected = 'PRESERVE-THIS-USER-INPUT ' + 'x'.repeat(20000)
  let r
  try {
    r = await runtime(() => [text('ack')], { root, config: { contextBudgetTokens: 4096, reminderTokens: 512 } })
    const agent = await r.create()
    success(await r.run(agent, 'Small initial task.'))
    const calls = r.requests.length
    const blocked = await r.run(agent, rejected)
    assert.equal(blocked.at(-1).data.reason.kind, 'error')
    assert.equal(r.requests.length, calls)
    await r.close()
    r = await runtime(() => [text('continued')], { root })
    const handle = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: 'scroll-agent', agentOptions: { provider: 'scripted', model: 'offline' } })
    success(await r.run(handle.agent, 'Continue the blocked request.'))
    assert.equal(contains(r.requests.at(-1).messages, rejected).length, 1)
    assert.equal(contains(handle.agent.session.deriveMessages(), rejected).length, 1)
  } finally {
    await r?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('storage failure before model admission preserves the claimed user input', async () => {
  const r = await runtime(() => [text('continued after storage recovery')])
  try {
    const agent = await r.create()
    const message = createUserMessage({ source: { kind: 'user' }, content: [text('KEEP-INPUT-ON-FLUSH-FAILURE')] })
    const unblock = r.ctx.on('session/flush', () => { throw new Error('Storage unavailable') })
    agent.followup(message)
    await agent.whenIdle()
    assert.equal(r.requests.length, 0)
    unblock()
    success(await r.run(agent, 'Storage repaired; continue.'))
    assert.equal(contains(r.requests.at(-1).messages, 'KEEP-INPUT-ON-FLUSH-FAILURE').length, 1)
  } finally { await r.close() }
})

test('the first request includes the full Minimal Notes persona and tool schemas in its budget', async () => {
  const r = await runtime(() => [text('must not be dispatched')], {
    config: { contextBudgetTokens: 1024, reminderTokens: 128 },
    systemPrompt: { personaPrefix: createMinimalNotesPreset(resolveConfig()).plugins[0].config.prefix },
  })
  try {
    const events = await r.run(await r.create(), 'Small user prompt.')
    assert.equal(r.requests.length, 0)
    assert.equal(events.at(-1).data.reason.kind, 'error')
  } finally { await r.close() }
})

test('later tool-schema changes are counted before provider dispatch', async () => {
  const r = await runtime(() => [text('ack')], { config: { contextBudgetTokens: 4096, reminderTokens: 512 } })
  try {
    const agent = await r.create()
    success(await r.run(agent, 'Initial task with the original toolset.'))
    const calls = r.requests.length
    r.ctx.tools.register({
      name: 'large_schema', description: 'Detailed contract '.repeat(2000),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [text(value)] },
      execute: async () => 'unused',
    })
    const events = await r.run(agent, 'Continue with the expanded toolset.')
    assert.equal(r.requests.length, calls)
    assert.equal(events.at(-1).data.reason.kind, 'error')
  } finally { await r.close() }
})

test('a reminder cannot push an admitted complete request over the working budget', async () => {
  const budget = 4096
  let agent
  const admitted = []
  const r = await runtime((_options, _step, ctx) => {
    admitted.push(ctx.tokenMeter.measure(agent.session).totalTokens)
    return [text('ack')]
  }, { config: { contextBudgetTokens: budget, reminderTokens: 512 } })
  try {
    agent = await r.create()
    success(await r.run(agent, 'Warm up without a reminder.'))
    const used = r.ctx.tokenMeter.measure(agent.session).totalTokens
    let low = 0
    let high = budget * 8
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const input = createUserMessage({ source: { kind: 'user' }, content: [text('x'.repeat(middle))] })
      if (used + r.ctx.tokenMeter.estimateMessage(input) <= budget - 16) low = middle
      else high = middle - 1
    }
    const before = r.requests.length
    const events = await r.run(agent, 'x'.repeat(low))
    if (r.requests.length === before) assert.equal(events.at(-1).data.reason.kind, 'error')
    else success(events)
    assert.ok(admitted.every(tokens => tokens <= budget), JSON.stringify(admitted))
  } finally { await r.close() }
})

test('budget enforcement in one agent scope leaves an unrelated agent untouched', async () => {
  const r = await runtime(() => [text('unrelated agent completed')], { mountScroll: false })
  try {
    const scoped = await r.ctx.agentLoop.createAgent(r.ctx, {
      sessionId: 'bounded-scope', agentOptions: { provider: 'scripted', model: 'offline' }, meta: { cwd: r.root },
      setup: async agentCtx => { await agentCtx.plugin(scroll, { contextBudgetTokens: 1024, reminderTokens: 128 }) },
    })
    const unrelated = await r.create('unrelated-scope')
    const large = 'scope boundary '.repeat(2000)
    const rejected = await r.run(scoped.agent, large)
    assert.equal(rejected.at(-1).data.reason.kind, 'error')
    success(await r.run(unrelated, large))
    assert.deepEqual(r.requests.map(request => request.sessionId), ['unrelated-scope'])
  } finally { await r.close() }
})

test('the first request after rollover retains the active runtime context', async () => {
  const policy = 'RUNTIME-POLICY: use the approved workspace only.'
  const r = await runtime((options, step) => {
    if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    if (step === 1) return [call('new_context')]
    assert.ok(options.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes(policy))))
    return [text('continued with current policy')]
  }, { systemPrompt: { includeRuntimeContext: true } })
  try {
    r.ctx.systemPrompt.context({ name: 'repair-runtime-policy', order: 10, text: policy })
    const events = await r.run(await r.create(), 'Continue with the active runtime policy.')
    success(events)
    assert.equal(replacementEvents(events).length, 1)
  } finally { await r.close() }
})

test('an accepted pending rollover survives a restart with changed checkpoint settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scroll-pending-settings-'))
  let r
  try {
    r = await runtime((_options, step) => step === 0
      ? [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
      : [call('new_context')], { root })
    const agent = await r.create()
    let pending = false
    const stopObserving = r.ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.meta?.scroll?.kind === 'rollover') pending = true
    })
    const unblock = r.ctx.on('session/flush', () => { if (pending) throw new Error('Interrupted rollover flush') })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [text('Continue the active task.')] }))
    await agent.whenIdle()
    assert.equal(pending, true)
    assert.ok(!agent.session.deriveMessages().some(message => message.source.kind === 'compaction-scroll-checkpoint'))
    unblock()
    stopObserving()
    await r.ctx.sessions.flush(agent.session)
    await r.close()
    r = await runtime(() => [text('Continue with the new settings.')], {
      root, config: { checkpointPath: 'renamed.md', maxCheckpointChars: 32 },
    })
    const handle = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: 'scroll-agent', agentOptions: { provider: 'scripted', model: 'offline' } })
    success(await r.run(handle.agent, 'Resume after changing checkpoint settings.'))
    assert.equal(contains(r.requests.at(-1).messages, 'Resume after changing checkpoint settings.').length, 1)
    success(await r.run(handle.agent, 'Continue again without repeating the rejected reset.'))
    assert.equal(r.requests.length, 2)
  } finally {
    await r?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('resume recovers the exact input from a durable crash cut after inbox claim', async () => {
  const original = 'RECOVER-CLAIMED-INPUT after an interrupted admission'
  const r = await runtime(() => [text('ack')])
  try {
    const agent = await r.create()
    const events = await r.run(agent, original)
    const admission = events.find(event => event.type === 'user/message' && contains([event.data], original).length)
    const claim = events.findLast(event => event.seq < admission.seq && event.type === 'agent/inbox/spliced' && event.data.removedCount > 0 && event.data.outcome !== 'canceled')
    assert.ok(claim, 'the recorded request must contain its inbox claim')
    // Persist the real prefix that could survive a crash before normal user/message admission.
    const handle = await r.ctx.sessionPersistence.create({ ...agent.session.header, id: 'crashed-admission' })
    try {
      await handle.append(events.slice(0, claim.seq + 1))
      await handle.flush()
    } finally { await handle.close() }
    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: 'crashed-admission', agentOptions: { provider: 'scripted', model: 'offline' } })
    success(await r.run(resumed.agent, 'Continue the interrupted request.'))
    assert.equal(contains(r.requests.at(-1).messages, original).length, 1)
    assert.equal(contains(resumed.agent.session.deriveMessages(), original).length, 1)
    success(await r.run(resumed.agent, 'A subsequent turn must not recover the same input again.'))
    assert.equal(contains(r.requests.at(-1).messages, original).length, 1)
  } finally { await r.close() }
})

test('explicitly canceled queued input is not resurrected on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scroll-canceled-input-'))
  const canceled = 'CANCELED-INSTRUCTION must not run'
  let r
  try {
    r = await runtime(() => [text('ack')], { root })
    const agent = await r.create()
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [text(canceled)] }), 'next-turn', false)
    agent.inbox.splice('next-turn', 0, 1, [])
    await r.ctx.sessions.flush(agent.session)
    await r.close()
    r = await runtime(() => [text('Only the remaining task is active.')], { root })
    const resumed = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: 'scroll-agent', agentOptions: { provider: 'scripted', model: 'offline' } })
    success(await r.run(resumed.agent, 'Do only the remaining task.'))
    assert.equal(contains(r.requests.at(-1).messages, canceled).length, 0)
    assert.equal(contains(resumed.agent.session.deriveMessages(), canceled).length, 0)
  } finally {
    await r?.close()
    await rm(root, { recursive: true, force: true })
  }
})
