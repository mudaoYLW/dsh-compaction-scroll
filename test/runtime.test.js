import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtime, call, text, checkpoint, replacementEvents, lastTool, toolText } from './support/runtime.js'

const success = events => assert.equal(events.at(-1).data.reason.kind, 'completed', JSON.stringify(events.at(-1)))

test('two context windows preserve evidence, inject the handoff, and resume notes from disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scroll-restart-'))
  let r
  try {
    r = await runtime((options, step) => {
      if (step === 0) return [call('evidence')]
      if (step === 1) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
      if (step === 2) return [call('new_context')]
      if (step === 3) {
        assert.ok(options.messages.some(message => message.source.kind === 'compaction-scroll-checkpoint' && JSON.stringify(message).includes(checkpoint.split('\n')[0])))
        assert.ok(!JSON.stringify(options.messages).includes('BUILD-4379'))
        assert.ok(options.messages.some(message => message.role === 'system'))
        return [call('scroll_history', { operation: 'search', query: 'BUILD-4379', window_id: -1 })]
      }
      if (step === 4) {
        const found = JSON.parse(toolText(lastTool(options)))
        assert.equal(found.items[0].type, 'tool/result')
        return [call('scroll_history', { operation: 'read', seq: found.items[0].seq })]
      }
      if (step === 5) {
        const read = JSON.parse(toolText(lastTool(options)))
        assert.match(read.text, /BUILD-4379/)
        return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint + '\nVerified build: BUILD-4379.' })]
      }
      if (step === 6) return [call('new_context')]
      assert.match(JSON.stringify(options.messages), /Verified build: BUILD-4379/)
      return [text('The original build evidence was recovered after rollover.')]
    }, { root })
    r.ctx.tools.register({ name: 'evidence', description: 'Return recorded build evidence.', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, value) => [text(value)] }, execute: async () => 'BUILD-4379 succeeded' })
    const agent = await r.create()
    const events = await r.run(agent, 'Inspect the build result, preserve the evidence, and continue.')
    success(events)
    assert.equal(replacementEvents(events).length, 2)
    assert.equal(r.requests.length, 8)
    const restoredId = agent.session.id
    await r.close()
    r = await runtime((options, step) => step === 0
      ? [call('scroll_notes_read', { path: 'handoff.md' })]
      : [text(JSON.parse(toolText(lastTool(options))).text)], { root })
    const handle = await r.ctx.agentLoop.resume(r.ctx, { resumeSessionId: restoredId, agentOptions: { provider: 'scripted', model: 'offline' } })
    const resumed = await r.run(handle.agent, 'Read the saved handoff after restart.')
    success(resumed)
    assert.match(JSON.stringify(r.requests.at(-1).messages), /Verified build: BUILD-4379/)
    assert.equal(replacementEvents(resumed).length, 2)
  } finally {
    await r?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('missing and previous-window checkpoints cannot clear context', async () => {
  const r = await runtime((options, step) => {
    if (step === 0) return [call('new_context')]
    if (step === 1) {
      assert.equal(lastTool(options).isError, true)
      return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    }
    if (step === 2) return [call('new_context')]
    if (step === 3) return [call('new_context')]
    assert.equal(lastTool(options).isError, true)
    assert.match(toolText(lastTool(options)), /fresh/)
    return [text('Kept the current window.')]
  })
  try {
    const events = await r.run(await r.create(), 'Do not lose this task.')
    success(events)
    assert.equal(replacementEvents(events).length, 1)
  } finally { await r.close() }
})

test('a batched reset is refused before later tool results could be lost', async () => {
  const r = await runtime((options, step) => {
    if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    if (step === 1) return [call('new_context'), call('scroll_notes_append', { path: 'handoff.md', text: '\nLater evidence.' })]
    const results = options.messages.filter(message => message.role === 'tool')
    assert.ok(results.some(message => message.isError && toolText(message).includes('only tool call')))
    return [text('Reset was refused; later evidence remains.')]
  })
  try {
    const events = await r.run(await r.create(), 'Preserve the later tool outcome.')
    success(events)
    assert.equal(replacementEvents(events).length, 0)
    assert.ok(events.some(event => event.data.meta?.scroll?.text?.includes('Later evidence.')))
  } finally { await r.close() }
})

test('a durability failure prevents reset; recovery consumes the pending request once', async () => {
  let failure = false
  const r = await runtime((_options, step) => step === 0
    ? [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    : step === 1 ? [call('new_context')] : [text('Continued after storage recovered.')])
  try {
    const agent = await r.create()
    const observe = r.ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.meta?.scroll?.kind === 'rollover') failure = true
    })
    const block = r.ctx.on('session/flush', () => { if (failure) throw new Error('Storage unavailable') })
    agent.followup((await import('@deepseek-ai/dsh-llm')).createUserMessage({ source: { kind: 'user' }, content: [text('Continue safely.')] }))
    await agent.whenIdle()
    assert.equal(r.requests.length, 2)
    assert.ok(!agent.session.deriveMessages().some(message => message.source.kind === 'compaction-scroll-checkpoint'))
    block()
    observe()
    const events = await r.run(agent, 'Storage has recovered; continue.')
    success(events)
    assert.equal(replacementEvents(events).length, 1)
    assert.ok(r.requests.at(-1).messages.some(message => JSON.stringify(message).includes('Storage has recovered')))
  } finally { await r.close() }
})

test('soft budget advice uses native context without forcing a rollover', async () => {
  const r = await runtime(() => [text('Continue working.')], {
    config: { contextBudgetTokens: 16000, reminderTokens: 8000 },
    systemPrompt: { includeRuntimeContext: true },
  })
  const advice = message => message.source.kind === 'runtime-context'
    && message.source.sections?.some(section => section.name === 'compaction-scroll:budget')
  try {
    const agent = await r.create()
    success(await r.run(agent, 'x'.repeat(80000)))
    success(await r.run(agent, 'Continue.'))
    assert.equal(r.requests.at(-1).messages.filter(advice).length, 1)
    const events = await r.run(agent, 'Continue again.')
    success(events)
    assert.equal(events.filter(event => event.type === 'user/message' && advice(event.data)).length, 1)
    assert.equal(replacementEvents(events).length, 0)
  } finally { await r.close() }
})
