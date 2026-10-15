import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { runtime, call, text, checkpoint, replacementEvents, lastTool, toolText } from './support/runtime.js'
import { nativeInputProjections, classifyHumanInputs } from './support/native-input-projection.js'

const completed = events => assert.equal(events.at(-1).data.reason.kind, 'completed', JSON.stringify(events.at(-1)))
const contains = (messages, value) => messages.filter(message => message.content.some(block => block.type === 'text' && block.text === value))

test('rollover clears the soft reminder and preserves native midturn steering exactly once', async () => {
  const projections = await nativeInputProjections()
  const steering = createUserMessage({ source: { kind: 'user' }, content: [text('NEW-STEERING: retain the verified artifact, do not rebuild it.')] })
  let agent
  const r = await runtime((_options, step) => {
    if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    if (step === 1) {
      agent.send(steering, 'next-step', false)
      return [call('new_context')]
    }
    return [text('Continue using the handoff and steering.')]
  }, { config: { contextBudgetTokens: 16000, reminderTokens: 8000 }, systemPrompt: { includeRuntimeContext: true } })
  try {
    agent = await r.create()
    completed(await r.run(agent, 'x'.repeat(80000)))
    const events = await r.run(agent, 'Continue the task after rollover.')
    completed(events)
    assert.equal(replacementEvents(events).length, 1)
    assert.equal(r.requests.length, 4)
    assert.equal(contains(r.requests[2].messages, steering.content[0].text).length, 1)
    assert.equal(contains(r.requests[3].messages, steering.content[0].text).length, 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === steering.id).length, 1)
    for (const definitions of Object.values(projections)) {
      assert.equal(classifyHumanInputs(definitions, events).get(steering.id), 'steering')
    }
    const contexts = r.requests.at(-1).messages.filter(message => message.source.kind === 'runtime-context')
    assert.ok(!contexts.at(-1)?.source.sections?.some(section => section.name === 'compaction-scroll:budget'))
    assert.ok(r.ctx.tokenMeter.measure(agent.session).totalTokens < 8000)
  } finally { await r.close() }
})

test('oversized arrival rejects pending rollover without blocking requests or losing original evidence', async () => {
  const arrival = 'ARRIVAL-EVIDENCE ' + 'z'.repeat(80000)
  const original = 'ORIGINAL-EVIDENCE before rollover'
  let agent
  const r = await runtime((_options, step) => {
    if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    if (step === 1) {
      agent.send(createUserMessage({ source: { kind: 'user' }, content: [text(arrival)] }), 'next-step', false)
      return [call('new_context')]
    }
    return [text('Keep the original context and continue normally.')]
  }, { config: { contextBudgetTokens: 16000, reminderTokens: 8000 } })
  try {
    agent = await r.create()
    const first = await r.run(agent, original)
    completed(first)
    assert.equal(replacementEvents(first).length, 0)
    assert.equal(contains(r.requests[2].messages, original).length, 1)
    assert.equal(contains(r.requests[2].messages, arrival).length, 1)
    assert.equal(first.filter(event => event.type === 'user/message' && event.data.source.kind === 'compaction-scroll-rejected').length, 1)
    const second = await r.run(agent, 'Continue without repeating the refused rollover.')
    completed(second)
    assert.equal(r.requests.length, 4)
    assert.equal(replacementEvents(second).length, 0)
    assert.equal(second.filter(event => event.type === 'user/message' && event.data.source.kind === 'compaction-scroll-rejected').length, 1)
  } finally { await r.close() }
})

test('legacy control carriers are filtered without hiding fresh human input', async () => {
  const r = await runtime(() => [text('Only the live task continues.')])
  try {
    const agent = await r.create()
    const control = createUserMessage({ source: { kind: 'compaction-scroll-control' }, content: [text('legacy control metadata')] })
    agent.send(control, 'next-step', false)
    const events = await r.run(agent, 'LIVE-HUMAN-INPUT')
    completed(events)
    assert.equal(r.requests.length, 1)
    assert.ok(!r.requests[0].messages.some(message => message.id === control.id))
    assert.equal(contains(r.requests[0].messages, 'LIVE-HUMAN-INPUT').length, 1)
  } finally { await r.close() }
})

for (const changed of ['system prompt', 'tool schemas']) {
  test(`rollover validates enlarged ${changed} instead of the previous request`, async () => {
    let enlarged = false
    const original = 'PRESERVE-ORIGINAL-EVIDENCE'
    const r = await runtime((_options, step) => {
      if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
      if (step === 1) return [call('new_context')]
      return [text('Continue without discarding the original context.')]
    }, { config: { contextBudgetTokens: 10000, reminderTokens: 2000 } })
    r.ctx.systemPrompt.section({ name: 'changing-policy', order: 1, text: () => enlarged && changed === 'system prompt' ? 'p'.repeat(80000) : 'Original policy' })
    r.ctx.on('session/event', (_session, event) => {
      if (event.type !== 'tool/result' || event.data.meta?.scroll?.kind !== 'rollover') return
      enlarged = true
      if (changed === 'tool schemas') r.ctx.tools.register({
        name: 'large_contract', description: 'd'.repeat(80000),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'string' }, render: (_args, value) => [text(value)] },
        execute: async () => 'unused',
      })
    })
    try {
      const agent = await r.create()
      const events = await r.run(agent, original)
      completed(events)
      assert.equal(r.requests.length, 3)
      assert.equal(replacementEvents(events).length, 0)
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'compaction-scroll-rejected').length, 1)
      assert.equal(contains(r.requests.at(-1).messages, original).length, 1)
      assert.ok(r.ctx.tokenMeter.measure(agent.session).totalTokens > 8000)
    } finally { await r.close() }
  })
}

test('fresh-window validation honors the final complete persona rather than suppressed sections', async () => {
  const persona = 'Continue the original task using the saved checkpoint.'
  const r = await runtime((_options, step) => step === 0
    ? [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
    : step === 1 ? [call('new_context')] : [text('Continue after the reset.')],
  { config: { contextBudgetTokens: 10000, reminderTokens: 2000 } })
  r.ctx.systemPrompt.section({ name: 'suppressed-policy', order: 1, text: 'x'.repeat(80000) })
  r.ctx.systemPrompt.section({ name: 'complete-persona', order: 2, complete: true, text: persona })
  try {
    const events = await r.run(await r.create(), 'Complete the active task.')
    completed(events)
    assert.equal(replacementEvents(events).length, 1)
    assert.equal(r.requests.length, 3)
    const system = r.requests.at(-1).messages.findLast(message => message.role === 'system')
    assert.equal(system.content[0].text, persona)
  } finally { await r.close() }
})

test('a fitting handoff excludes the retiring reminder but retains active runtime policy', async () => {
  const policy = 'RETAINED-POLICY: inspect the existing artifact before rebuilding.'
  const probe = async freshTarget => {
    let freshUsage
    const r = await runtime((options, step, ctx) => {
      if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
      if (step === 1) {
        assert.ok(options.messages.some(message => message.source.sections?.some(section => section.name === 'compaction-scroll:budget')))
        return [call('new_context')]
      }
      freshUsage = ctx.tokenMeter.measure(ctx.sessions.get(options.sessionId)).totalTokens
      return [text('Continue the task under the retained policy.')]
    }, {
      config: { contextBudgetTokens: freshTarget + 512, reminderTokens: 512, maxOutputChars: 256 },
      systemPrompt: { includeRuntimeContext: true },
    })
    r.ctx.systemPrompt.context({ name: 'retained-policy', order: 1, text: policy })
    try {
      const events = await r.run(await r.create(), 'x'.repeat(80000))
      completed(events)
      assert.equal(replacementEvents(events).length, 1)
      assert.equal(r.requests.length, 3)
      const contexts = r.requests.at(-1).messages.filter(message => message.source.kind === 'runtime-context')
      assert.ok(contexts.some(message => message.source.sections?.some(section => section.text === policy)))
      assert.ok(!contexts.some(message => message.source.sections?.some(section => section.name === 'compaction-scroll:budget')))
      assert.ok(freshUsage < freshTarget)
      return freshUsage
    } finally { await r.close() }
  }
  const actualReplacementCost = await probe(8000)
  await probe(actualReplacementCost + 32)
})

test('old provider usage cannot reject a small replacement, while normal budget queries remain calibrated', async () => {
  const config = { contextBudgetTokens: 16000, reminderTokens: 2000, maxOutputChars: 256 }
  const original = '汉'.repeat(40000)
  const r = await runtime(() => { throw new Error('The usage-reporting adapter must handle this session') }, { config })
  const requests = []
  class UsageAdapter extends LlmAdapter {
    async *stream(options) {
      const step = requests.length
      requests.push(options)
      let blocks
      switch (step) {
        case 0:
          blocks = [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
          break
        case 1:
        case 4:
          blocks = [call('get_context_remaining')]
          break
        case 2: {
          const status = JSON.parse(toolText(lastTool(options)))
          assert.equal(status.baseline, 'usage')
          assert.ok(status.used_tokens >= 40000)
          assert.equal(status.over_budget, true)
          blocks = [call('new_context')]
          break
        }
        case 3:
          assert.ok(options.messages.some(message => message.source.kind === 'compaction-scroll-checkpoint'))
          assert.equal(contains(options.messages, original).length, 0)
          blocks = [text('Continue the original task after the small handoff.')]
          break
        default: {
          assert.equal(step, 5)
          const status = JSON.parse(toolText(lastTool(options)))
          assert.equal(status.baseline, 'usage')
          assert.ok(status.used_tokens >= 2020 && status.used_tokens < 14000)
          assert.equal(status.over_budget, false)
          blocks = [text('The next window follows its own provider usage.')]
        }
      }
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'usage', usage: step < 3
        ? { inputTokens: 10000, cacheReadTokens: 30000, outputTokens: 100 }
        : { inputTokens: 2000, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  r.ctx.llm.registerAdapter(['usage-probe'], new UsageAdapter())
  try {
    const agent = await r.ctx.agentLoop.create('usage-agent', { provider: 'usage-probe', model: 'offline' }, { cwd: r.root })
    const first = await r.run(agent, original)
    completed(first)
    assert.equal(requests.length, 4)
    assert.equal(replacementEvents(first).length, 1)
    assert.equal(first.filter(event => event.type === 'user/message' && event.data.source.kind === 'compaction-scroll-rejected').length, 0)
    assert.equal(first.find(event => event.type === 'user/message' && event.data.source.kind === 'user').data.content[0].text, original)
    const second = await r.run(agent, 'Continue in the new window.')
    completed(second)
    assert.equal(requests.length, 6)
    assert.equal(replacementEvents(second).length, 1)
  } finally { await r.close() }
})
