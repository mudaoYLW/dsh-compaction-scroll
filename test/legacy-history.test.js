import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildForkSeed } from '@deepseek-ai/dsh-session'
import { runtime, call, text, checkpoint, replacementEvents, lastTool, toolText } from './support/runtime.js'

let executionId = 0
async function execute(r, agent, name, args) {
  const result = await r.ctx.tools.execute({
    callId: `historical-read-${++executionId}`, name, arguments: args,
    agent, signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, toolText(result))
  return JSON.parse(toolText(result))
}

async function readOriginal(r, agent, event) {
  let offset = 0
  let original = ''
  do {
    const page = await execute(r, agent, 'scroll_history', {
      operation: 'read', seq: event.seq, offset, limit: 97,
    })
    assert.ok(JSON.stringify(page).length <= 512)
    assert.equal(page.offset, offset)
    assert.equal(page.total_chars, JSON.stringify(event).length)
    assert.ok(page.text.length > 0 && page.text.length <= 97)
    original += page.text
    if (page.has_more) assert.equal(page.next_offset, offset + page.text.length)
    else assert.equal(page.next_offset, null)
    offset = page.next_offset
  } while (offset !== null)
  assert.equal(original, JSON.stringify(event))
  return JSON.parse(original)
}

test('restarted notes and checkpoints coexist with exact raw legacy journal reads, without control replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scroll-legacy-history-'))
  let r
  try {
    r = await runtime((_options, step) => step === 0
      ? [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
      : step === 1 ? [call('new_context')] : [text('The explicit checkpoint is complete.')], { root })
    const agent = await r.create('legacy-source')
    const seed = await r.run(agent, 'Preserve this task with an explicit checkpoint.')
    assert.equal(seed.at(-1).data.reason.kind, 'completed')
    assert.equal(replacementEvents(seed).length, 1)
    const accepted = {
      id: 'historical-accepted-child', role: 'user',
      source: { kind: 'subagent-settled', senderSessionId: 'historical-child' },
      content: [text('LEGACY_APPROVED_EVIDENCE "\\\n🙂'.repeat(30))],
    }
    const admission = {
      seq: seed.length, time: seed.at(-1).time, type: 'agent/inbox/spliced',
      data: {
        target: 'next-step', start: 0, inserted: [],
        compactionScroll: {
          version: 1, kind: 'admission',
          batch: { version: 2, accepted: [], dropped: [], messages: [accepted], humanWakeId: null },
        },
      },
    }
    const paused = {
      seq: seed.length + 1, time: seed.at(-1).time, type: 'agent/inbox/spliced',
      data: {
        target: 'next-step', start: 0, inserted: [],
        compactionScroll: {
          version: 1, kind: 'recovery',
          recovery: {
            phase: 'paused', steps: 7, pauseReason: 'legacy pause', retryInputId: null,
            pauseNoticeSent: true, normalOutputCaptured: true, normalMaxTokens: 16,
          },
        },
      },
    }
    // Persist an immutable old-format log fixture; the plugin has no journal writer.
    const writer = await r.ctx.sessionPersistence.create({ ...agent.session.header, id: 'legacy-journal-reader' })
    try {
      await writer.append([...seed, admission, paused])
      await writer.flush()
    } finally { await writer.close() }
    await r.close()
    r = await runtime((options, step) => {
      assert.ok(!options.messages.some(message => message.id === accepted.id), 'Historical admission must not replay into model input')
      if (step === 0) return [call('scroll_notes_read', { path: 'handoff.md' })]
      assert.equal(JSON.parse(toolText(lastTool(options))).text, checkpoint)
      return [text('The task continued without restoring historical recovery state.')]
    }, { root, config: { maxOutputChars: 512 } })
    const { agent: resumed } = await r.ctx.agentLoop.resume(r.ctx, {
      resumeSessionId: 'legacy-journal-reader', agentOptions: { provider: 'scripted', model: 'offline' },
    })
    assert.deepEqual((await readOriginal(r, resumed, admission)).data.compactionScroll.batch.messages, [accepted])
    assert.deepEqual(await readOriginal(r, resumed, paused), paused)
    assert.deepEqual((await execute(r, resumed, 'scroll_history', {
      operation: 'search', query: 'LEGACY_APPROVED_EVIDENCE',
    })).items, [])
    const listed = []
    let offset = 0
    do {
      const page = await execute(r, resumed, 'scroll_history', { operation: 'list', offset })
      listed.push(...page.items.map(item => item.seq))
      offset = page.next_offset
    } while (offset !== null)
    assert.ok(!listed.includes(admission.seq) && !listed.includes(paused.seq))
    const events = await r.run(resumed, 'Continue the saved task without replaying old control metadata.')
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    assert.equal(r.requests.length, 2)
    assert.equal(replacementEvents(events).length, 1)
    assert.deepEqual(events.slice(0, seed.length + 2), [...seed, admission, paused])
    assert.ok(!events.slice(seed.length + 2).some(event => Object.hasOwn(event.data, 'compactionScroll')))
  } finally {
    await r?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a native fork keeps notes but requires its own fresh explicit checkpoint', async () => {
  let childStep = null
  const childHandoff = `${checkpoint}\nNext: continue the independent child task.`
  const r = await runtime((options, step) => {
    if (childStep === null) {
      if (step === 0) return [call('scroll_notes_write', { path: 'handoff.md', text: checkpoint })]
      if (step === 1) return [call('new_context')]
      return [text('The parent finished its rollover.')]
    }
    switch (childStep++) {
      case 0:
        assert.ok(!options.messages.some(message => message.source?.kind === 'compaction-scroll-checkpoint'))
        return [call('new_context')]
      case 1:
        assert.equal(lastTool(options).isError, true)
        assert.match(toolText(lastTool(options)), /fresh/)
        return [call('scroll_notes_read', { path: 'handoff.md' })]
      case 2:
        assert.equal(JSON.parse(toolText(lastTool(options))).text, checkpoint)
        return [call('scroll_notes_write', { path: 'handoff.md', text: childHandoff })]
      case 3:
        return [call('new_context')]
      default:
        assert.ok(options.messages.some(message => message.source?.kind === 'compaction-scroll-checkpoint'
          && toolText(message).includes(childHandoff)))
        return [text('The fork continued from its own explicit checkpoint.')]
    }
  })
  try {
    const parent = await r.create('fork-checkpoint-parent')
    const events = await r.run(parent, 'Preserve the parent handoff.')
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    const pending = events.find(event => event.type === 'tool/result' && event.data.meta?.scroll?.kind === 'rollover')
    assert.ok(pending)
    const inheritedEventCount = pending.seq + 1
    const seed = buildForkSeed(events, pending.seq)
    const writer = await r.ctx.sessionPersistence.create({
      ...parent.session.header, id: 'fork-checkpoint-child', isSeeded: true, parentSession: parent.session.id,
    }, { inheritedEventCount })
    try {
      await writer.append(seed)
      await writer.flush()
    } finally { await writer.close() }
    childStep = 0
    const { agent: child } = await r.ctx.agentLoop.resume(r.ctx, {
      resumeSessionId: 'fork-checkpoint-child', agentOptions: { provider: 'scripted', model: 'offline' },
    })
    const childEvents = await r.run(child, 'Continue as an independent fork.')
    assert.equal(childEvents.at(-1).data.reason.kind, 'completed')
    assert.equal(childStep, 5)
    const resets = replacementEvents(childEvents)
    assert.equal(resets.length, 1)
    assert.ok(resets[0].seq > inheritedEventCount)
    assert.equal((await execute(r, parent, 'scroll_notes_read', { path: 'handoff.md' })).text, checkpoint)
    assert.equal((await execute(r, child, 'scroll_notes_read', { path: 'handoff.md' })).text, childHandoff)
  } finally { await r.close() }
})
