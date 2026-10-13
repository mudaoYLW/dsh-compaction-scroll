import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { subagentRuntime } from './support/subagents.js'
import { call, text, lastTool, toolText, checkpoint, replacementEvents } from './support/runtime.js'

const body = options => JSON.stringify(options.messages.filter(message => message.role !== 'system'))

test('background child survives parent rollover with private notes and delivers its result', { timeout: 15000 }, async () => {
  const release = Promise.withResolvers()
  const delivered = Promise.withResolvers()
  let parentStep = 0
  let childStep = 0
  let childId
  const rt = await subagentRuntime(async options => {
    if (options.sessionId !== 'notes-parent') {
      switch (childStep++) {
        case 0:
          await release.promise
          return [call('scroll_notes_read', { path: 'private.md' })]
        case 1:
          assert.doesNotMatch(toolText(lastTool(options)), /PARENT_SECRET/)
          return [call('scroll_notes_write', { path: 'private.md', text: 'CHILD_SECRET' })]
        case 2: return [call('scroll_notes_read', { path: 'private.md' })]
        default:
          assert.match(toolText(lastTool(options)), /CHILD_SECRET/)
          return [text('CHILD_RESULT_VERIFIED')]
      }
    }
    switch (parentStep++) {
      case 0: return [call('scroll_notes_write', { path: 'private.md', text: 'PARENT_SECRET' })]
      case 1: return [call('subagent', { description: 'isolated note work', prompt: 'CHILD_TASK: inspect and write your private note.' })]
      case 2:
        childId = toolText(lastTool(options)).match(/started subagent (\S+)/)?.[1]
        assert.ok(childId, toolText(lastTool(options)))
        return [call('scroll_notes_write', { path: 'handoff.md', text: `${checkpoint}\nOutstanding child: ${childId}; wait for its note result.` })]
      case 3: return [call('new_context')]
      case 4:
        assert.match(body(options), new RegExp(childId))
        return [call('scroll_notes_read', { path: 'private.md' })]
      case 5:
        assert.match(toolText(lastTool(options)), /PARENT_SECRET/)
        assert.doesNotMatch(toolText(lastTool(options)), /CHILD_SECRET/)
        return [text('Waiting for outstanding child.')]
      default:
        assert.match(body(options), /CHILD_RESULT_VERIFIED/)
        delivered.resolve()
        return [text('Parent received verified child result after rollover.')]
    }
  })
  try {
    await rt.run(rt.parent, 'PARENT_TASK: delegate isolated notes and reset your own context.')
    release.resolve()
    await delivered.promise
    await rt.parent.whenIdle()
    const events = await rt.run(rt.parent, 'Confirm completion.')
    assert.equal(replacementEvents(events).length, 1)
    assert.equal(childStep, 4)
    assert.equal((await rt.ctx.subagents.listChildren(rt.parent.session.id)).length, 1)
  } finally {
    release.resolve()
    await rt.close()
  }
})

test('foreground child returns its result without resetting parent context', { timeout: 15000 }, async () => {
  let parentStep = 0
  const rt = await subagentRuntime(options => {
    if (options.sessionId !== 'notes-parent') return [text('FOREGROUND_RESULT')]
    if (parentStep++ === 0) return [call('subagent', { description: 'foreground check', prompt: 'FOREGROUND_TASK', run_in_background: false })]
    assert.match(toolText(lastTool(options)), /FOREGROUND_RESULT/)
    return [text('Foreground result received.')]
  })
  try {
    const events = await rt.run(rt.parent, 'Run one foreground child.')
    assert.equal(replacementEvents(events).length, 0)
    assert.equal(parentStep, 2)
  } finally { await rt.close() }
})

test('delegated shell inherits read-only scope and retains policy after child rollover', { timeout: 60000, skip: process.platform === 'win32' && 'POSIX shell scenario' }, async () => {
  let parentStep = 0
  let childStep = 0
  let childId
  let rt
  rt = await subagentRuntime(async options => {
    if (options.sessionId !== 'notes-parent') {
      childId = options.sessionId
      const session = rt.ctx.sessions.get(childId)
      const policy = rt.ctx.sandboxPolicy.resolve({ session })
      assert.equal(policy.mode, 'read-only')
      assert.equal(await realpath(policy.workspaceRoot), await realpath(rt.root))
      assert.equal(rt.ctx.approval.overrideOf(session), 'never')
      const snapshot = options.messages.findLast(message => message.source?.kind === 'runtime-context')
      assert.ok(snapshot, 'Child must receive the native runtime policy snapshot, including after rollover')
      assert.match(toolText(snapshot), /read-only/)
      switch (childStep++) {
        case 0: return [call('scroll_notes_write', { path: 'handoff.md', text: `${checkpoint}\nRead shared.txt; writes are forbidden by inherited read-only policy.` })]
        case 1: return [call('new_context')]
        case 2: return [call('bash', { command: 'pwd; cat shared.txt; printf changed > shared.txt' })]
        default:
          assert.equal(await realpath(toolText(lastTool(options)).split('\n')[0]), await realpath(rt.root))
          assert.match(toolText(lastTool(options)), /parent-evidence/)
          assert.equal(await readFile(join(rt.root, 'shared.txt'), 'utf8'), 'parent-evidence')
          return [text('Read parent evidence; inherited policy prevented modification.')]
      }
    }
    switch (parentStep++) {
      case 0: return [call('bash', { command: 'cat shared.txt' })]
      case 1:
        assert.match(toolText(lastTool(options)), /parent-evidence/)
        return [call('subagent', { description: 'restricted shell inspection', prompt: 'Inspect shared.txt within the delegated scope.', run_in_background: false })]
      default:
        assert.match(toolText(lastTool(options)), /inherited policy prevented modification/)
        return [text('Delegated inspection completed without modifying evidence.')]
    }
  })
  try {
    await writeFile(join(rt.root, 'shared.txt'), 'parent-evidence')
    setSandboxMode(rt.parent.session, 'read-only')
    const events = await rt.run(rt.parent, 'Read evidence, then delegate a read-only inspection.')
    assert.equal(parentStep, 3)
    assert.equal(childStep, 4)
    assert.equal(replacementEvents(events).length, 0)
    assert.equal(rt.ctx.approval.overrideOf(rt.parent.session), undefined)
    const handle = await rt.ctx.sessionPersistence.open(childId, 'read')
    try {
      const childEvents = (await handle.read()).events
      assert.equal(replacementEvents(childEvents).length, 1)
      assert.ok(childEvents.some(event => event.type === 'sandbox/mode' && event.data.mode === 'read-only' && event.data.source === 'delegation'))
    } finally { await handle.close() }
  } finally { await rt.close() }
})
