import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
