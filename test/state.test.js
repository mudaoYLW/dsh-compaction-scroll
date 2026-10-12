import test from 'node:test'
import assert from 'node:assert/strict'
import { history, listNotes, prepareNote, readNote, readState } from '../src/state.js'

const noteLimits = { maxNoteBytes: 64, maxNotes: 8, maxTotalNoteBytes: 128 }
const historyLimits = { maxResults: 20, maxOutputChars: 4000 }

// The runtime supplies this persistence-backed view, not a host Session reader.
function logView(seed = []) {
  const events = structuredClone(seed)
  const reads = []
  return {
    reads,
    get seq() { return events.length },
    snapshotEvents(from = 0, to = events.length) {
      reads.push([from, to])
      return events.slice(from, to)
    },
    append(type, data, options = {}) {
      const event = { seq: events.length, time: events.length, type, data, ...options }
      events.push(event)
      return event
    },
    deriveEventMessage(event) {
      if (event.type === 'user/message') return event.data
      if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message
      return null
    },
  }
}

function user(view, text, source = { kind: 'user' }, surfaceOp = 'append') {
  return view.append('user/message', {
    id: `message-${view.seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, { surfaceOp })
}

function result(view, name, scroll, isError = false) {
  const call = view.append('tool/call', {
    turn: 0, step: 0, callId: `call-${view.seq}`, name, arguments: '{}',
  })
  return view.append('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: `message-${view.seq}`,
      role: 'tool',
      source: { kind: 'tool', callId: call.data.callId },
      toolCallId: call.data.callId,
      content: [{ type: 'text', text: isError ? 'failed' : 'saved' }],
      isError,
    },
    ...(scroll === undefined ? {} : { meta: { scroll } }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

function note(view, path, text, name = 'scroll_notes_write') {
  return result(view, name, { version: 1, kind: 'note', path, text })
}

function reset(view, text = 'Saved checkpoint') {
  return user(view, text, { kind: 'compaction-scroll-checkpoint', form: 'recall' }, {
    op: 'replace', startSeq: 0, endSeq: view.seq - 1,
  })
}

test('notes fold only the unseen committed tail and use durable sequence revisions', () => {
  const view = logView()
  assert.deepEqual(readState(view), { notes: new Map(), pending: null, lastResetSeq: -1 })
  const write = note(view, 'handoff.md', 'first')
  const state = readState(view)
  assert.deepEqual(state.notes.get('handoff.md'), { text: 'first', revision: write.seq })
  assert.deepEqual(view.reads, [[0, view.seq]])
  readState(view)
  assert.equal(view.reads.length, 1)

  const append = note(view, 'handoff.md', 'first plus second', 'scroll_notes_append')
  assert.deepEqual(readState(view).notes.get('handoff.md'), {
    text: 'first plus second', revision: append.seq,
  })
  assert.deepEqual(view.reads[1], [write.seq + 1, append.seq + 1])
  const replay = logView(view.snapshotEvents())
  assert.deepEqual(readState(replay), readState(view))
  assert.equal(readState(logView()).notes.size, 0)
})

test('a source call folded earlier still authenticates its later result', () => {
  const view = logView()
  const call = view.append('tool/call', { name: 'scroll_notes_write', callId: 'a', arguments: '{}' })
  assert.equal(readState(view).notes.size, 0)
  const saved = view.append('tool/result', {
    message: { isError: false },
    meta: { scroll: { version: 1, kind: 'note', path: 'a', text: 'one' } },
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  assert.deepEqual(readState(view).notes.get('a'), { text: 'one', revision: saved.seq })
  assert.deepEqual(view.reads, [[0, 1], [1, 2]])
})

test('failed, unlinked, foreign and merely text-shaped metadata cannot create notes', () => {
  const view = logView()
  const metadata = { version: 1, kind: 'note', path: 'forged', text: 'not a note' }
  result(view, 'foreign_tool', metadata)
  result(view, 'scroll_notes_write', { version: 99 }, true)
  const prompt = user(view, JSON.stringify(metadata))
  view.append('tool/result', {
    message: { isError: false }, meta: { scroll: metadata },
  }, { sourceEventSeqs: [prompt.seq], surfaceOp: 'append' })
  view.append('tool/result', {
    message: { isError: false }, meta: { scroll: metadata },
  }, { surfaceOp: 'append' })
  const call = view.append('tool/call', { name: 'scroll_notes_write', arguments: '{}' })
  view.append('tool/result', {
    message: {}, meta: { scroll: metadata },
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  assert.equal(readState(view).notes.size, 0)
})

test('malformed metadata from recognized successful tools reports corruption', () => {
  for (const metadata of [
    undefined,
    null,
    [],
    { version: 2, kind: 'note', path: 'a', text: 'text' },
    { version: 1, kind: 'note', path: '../a', text: 'text' },
    { version: 1, kind: 'note', path: 'a', text: 3 },
    { version: 1, kind: 'unknown', path: 'a' },
    { version: 1, kind: 'rollover', path: 'a', revision: 0 },
  ]) {
    const view = logView()
    const event = result(view, 'scroll_notes_write', metadata)
    assert.throws(() => readState(view), new RegExp(`Scroll state corruption at event ${event.seq}:`))
  }
})

test('a corrupt tail does not get skipped or replay previously accepted notes', () => {
  const view = logView()
  const saved = note(view, 'a', 'unchanged')
  const borrowed = readState(view)
  const broken = result(view, 'scroll_notes_append', { version: 1, kind: 'note', path: 'a' })
  assert.throws(() => readState(view), /Scroll state corruption/)
  assert.deepEqual(borrowed.notes.get('a'), { text: 'unchanged', revision: saved.seq })
  assert.throws(() => readState(view), /Scroll state corruption/)
  assert.deepEqual(view.reads.at(-1), [broken.seq, view.seq])
})

test('rollover remains pending until a replacement checkpoint clears it without deleting notes', () => {
  const view = logView()
  const saved = note(view, 'handoff.md', 'continue here')
  const rollover = result(view, 'new_context', {
    version: 1, kind: 'rollover', path: 'handoff.md', revision: saved.seq,
  })
  const expected = { seq: rollover.seq, path: 'handoff.md', revision: saved.seq }
  assert.deepEqual(readState(view).pending, expected)
  result(view, 'new_context', undefined, true)
  user(view, 'not a reset', { kind: 'compaction-scroll-checkpoint', form: 'recall' })
  user(view, 'not a reset', { kind: 'user', plugin: 'dsh-compaction-scroll:checkpoint' }, {
    op: 'replace', startSeq: 0, endSeq: view.seq - 1,
  })
  assert.deepEqual(readState(view).pending, expected)
  const checkpoint = reset(view)
  const state = readState(view)
  assert.equal(state.pending, null)
  assert.equal(state.lastResetSeq, checkpoint.seq)
  assert.deepEqual(state.notes.get('handoff.md'), { text: 'continue here', revision: saved.seq })
  assert.deepEqual(readState(logView(view.snapshotEvents())), state)
  const newer = note(view, 'handoff.md', 'next window')
  assert.ok(readState(view).notes.get('handoff.md').revision > state.lastResetSeq)
  assert.equal(readState(view).notes.get('handoff.md').revision, newer.seq)
})

test('rollover metadata must reference an existing exact note revision', () => {
  for (const revision of [0, -1, 1.5, '1', undefined]) {
    const view = logView()
    note(view, 'handoff.md', 'original')
    result(view, 'new_context', { version: 1, kind: 'rollover', path: 'handoff.md', revision })
    assert.throws(() => readState(view), /Scroll state corruption.*existing note revision/)
  }
  const missing = logView()
  result(missing, 'new_context', { version: 1, kind: 'rollover', path: 'missing', revision: 0 })
  assert.throws(() => readState(missing), /Scroll state corruption/)
  const stale = logView()
  const original = note(stale, 'handoff.md', 'old')
  note(stale, 'handoff.md', 'new')
  result(stale, 'new_context', { version: 1, kind: 'rollover', path: 'handoff.md', revision: original.seq })
  assert.throws(() => readState(stale), /Scroll state corruption/)
  const mismatch = logView()
  result(mismatch, 'new_context', { version: 1, kind: 'note', path: 'a', text: 'wrong tool' })
  assert.throws(() => readState(mismatch), /Scroll state corruption.*source tool\/call/)
})

test('prepareNote returns full write/append content without committing it', () => {
  const view = logView()
  assert.deepEqual(prepareNote(view, { path: 'dir/note', text: 'first' }, true, noteLimits), {
    version: 1, kind: 'note', path: 'dir/note', text: 'first',
  })
  assert.equal(readState(view).notes.size, 0)
  note(view, 'dir/note', 'first')
  assert.equal(prepareNote(view, { path: 'dir/note', text: 'second' }, true, noteLimits).text, 'firstsecond')
  assert.equal(prepareNote(view, { path: 'dir/note', text: '' }, false, noteLimits).text, '')
  assert.equal(readNote(view, { path: 'dir/note' }).text, 'first')
})

test('virtual note paths reject traversal, absolute paths and ambiguous separators', () => {
  for (const path of ['', '/', '/a', 'a/', 'a//b', '.', '..', './a', 'a/../b', 'a/./b', 'a\\b', 'C:/a', 'C:a', 'a\0b', 'a\nb', null]) {
    assert.throws(() => prepareNote(logView(), { path, text: '' }, false, noteLimits), /relative virtual note path/)
  }
  for (const path of ['.hidden', 'a..b', '目录/笔记.md', 'nested/path name']) {
    assert.equal(prepareNote(logView(), { path, text: '' }, false, noteLimits).path, path)
  }
  assert.throws(() => prepareNote(logView(), { path: 'a', text: 1 }, false, noteLimits), /text must be a string/)
})

test('UTF-8, note count and total budgets account for replacements and appends', () => {
  const view = logView()
  const limits = { maxNoteBytes: 8, maxNotes: 2, maxTotalNoteBytes: 10 }
  assert.equal(prepareNote(view, { path: 'a', text: '🙂🙂' }, false, limits).text, '🙂🙂')
  assert.throws(() => prepareNote(view, { path: 'a', text: '🙂🙂x' }, false, limits), /maxNoteBytes/)
  note(view, 'a', '123456')
  note(view, 'b', 'éé')
  assert.equal(prepareNote(view, { path: 'a', text: 'abcdef' }, false, limits).text, 'abcdef')
  assert.throws(() => prepareNote(view, { path: 'a', text: 'x' }, true, limits), /maxTotalNoteBytes/)
  assert.throws(() => prepareNote(view, { path: 'c', text: '' }, false, limits), /maxNotes/)
  note(view, 'a', '1')
  assert.equal(prepareNote(view, { path: 'b', text: '🙂' }, true, limits).text, 'éé🙂')
  assert.throws(() => prepareNote(view, { path: 'b', text: '🙂x' }, true, limits), /maxNoteBytes/)
})

test('note reads use inclusive one-based lines and preserve full text when unbounded', () => {
  const view = logView()
  const saved = note(view, 'a', 'first\n\nthird\nfourth\n')
  assert.deepEqual(readNote(view, { path: 'a' }), {
    path: 'a', revision: saved.seq, text: 'first\n\nthird\nfourth\n',
  })
  assert.equal(readNote(view, { path: 'a', start_line: 2, stop_line: 3 }).text, '\nthird')
  assert.equal(readNote(view, { path: 'a', stop_line: 1 }).text, 'first')
  assert.equal(readNote(view, { path: 'a', start_line: 4 }).text, 'fourth\n')
  assert.equal(readNote(view, { path: 'a', start_line: 99 }).text, '')
  assert.equal(readNote(view, { path: 'a', stop_line: 99 }).text, 'first\n\nthird\nfourth\n')
  assert.throws(() => readNote(view, { path: 'a', start_line: 3, stop_line: 2 }), /stop_line/)
  for (const bound of [0, -1, 1.5, '2', null]) {
    assert.throws(() => readNote(view, { path: 'a', start_line: bound }), /start_line/)
    assert.throws(() => readNote(view, { path: 'a', stop_line: bound }), /stop_line/)
  }
  assert.throws(() => readNote(view, { path: 'missing' }), /note not found/)
})

test('note listing is lexical, prefix-filtered and reports UTF-8 sizes', () => {
  const view = logView()
  note(view, 'z', '')
  const x = note(view, 'a/x', '🙂')
  const b = note(view, 'a/b', 'é')
  assert.deepEqual(listNotes(view, { prefix: 'a/' }), [
    { path: 'a/b', revision: b.seq, bytes: 2 },
    { path: 'a/x', revision: x.seq, bytes: 4 },
  ])
  assert.deepEqual(listNotes(view).map(item => item.path), ['a/b', 'a/x', 'z'])
  assert.deepEqual(listNotes(view, { prefix: 'A/' }), [])
})

function conversation() {
  const view = logView()
  view.append('turn/start', { turn: 0 })
  const prompt = user(view, 'old needle[0] prompt')
  const answer = view.append('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'reasoning phrase' },
        { type: 'text', text: 'NEEDLE[0] only uppercase' },
        { type: 'tool-call', id: 'c', name: 'foreign_tool', arguments: 'hidden-arguments' },
      ],
    },
    stream: [{ exact: 'raw stream must survive a read' }],
  }, { surfaceOp: 'append' })
  const tool = result(view, 'foreign_tool', { opaque: ['private metadata'] })
  const checkpoint = reset(view, 'new context checkpoint')
  const newer = user(view, 'new needle[0] prompt')
  view.append('assistant/attempt', { stream: [{ text: 'hidden-attempt' }] })
  const current = view.append('tool/call', {
    name: 'scroll_history', arguments: 'hidden-current-query', callId: 'current',
  })
  return { view, prompt, answer, tool, checkpoint, newer, current }
}

test('history windows partition the original log at checkpoint sequences', () => {
  const { view, checkpoint, current } = conversation()
  const page = history(view, { operation: 'windows' }, historyLimits)
  assert.deepEqual(page.items, [
    { window_id: -1, start_seq: 0, end_seq: checkpoint.seq - 1, event_count: 3, current: false },
    { window_id: checkpoint.seq, start_seq: checkpoint.seq, end_seq: current.seq, event_count: 2, current: true },
  ])
  assert.equal(page.has_more, false)
  assert.equal(page.next_offset, null)
  const nextCheckpoint = reset(view)
  const first = history(view, { operation: 'windows', limit: 2 }, historyLimits)
  assert.equal(first.next_offset, 2)
  assert.equal(first.has_more, true)
  const second = history(view, { operation: 'windows', offset: first.next_offset }, historyLimits)
  assert.equal(second.items[0].window_id, nextCheckpoint.seq)
  assert.equal(second.has_more, false)
})

test('history lists replaced originals and checkpoint nodes but not raw calls or attempts', () => {
  const { view, prompt, answer, tool, checkpoint, newer } = conversation()
  const limits = { maxResults: 2, maxOutputChars: 4000 }
  const first = history(view, { operation: 'list', limit: 99 }, limits)
  assert.deepEqual(first.items.map(item => item.seq), [prompt.seq, answer.seq])
  assert.equal(first.next_offset, 2)
  const second = history(view, { operation: 'list', offset: first.next_offset }, limits)
  assert.deepEqual(second.items.map(item => item.seq), [tool.seq, checkpoint.seq])
  assert.equal(second.next_offset, 4)
  const third = history(view, { operation: 'list', offset: second.next_offset }, limits)
  assert.deepEqual(third.items.map(item => item.seq), [newer.seq])
  assert.equal(third.has_more, false)
  assert.equal(third.next_offset, null)
  assert.deepEqual(history(view, { operation: 'list', window_id: -1 }, historyLimits).items.map(item => item.seq), [prompt.seq, answer.seq, tool.seq])
  assert.deepEqual(history(view, { operation: 'list', window_id: checkpoint.seq }, historyLimits).items.map(item => item.seq), [checkpoint.seq, newer.seq])
  assert.equal(history(logView(), { operation: 'list' }, historyLimits).items.length, 0)
})

test('history search is literal, case-sensitive, window-scoped and excludes arguments', () => {
  const { view, prompt, answer, checkpoint, newer } = conversation()
  const matches = history(view, { operation: 'search', query: 'needle[0]' }, historyLimits)
  assert.deepEqual(matches.items.map(item => item.seq), [prompt.seq, newer.seq])
  assert.equal(matches.items[0].match_offset, 4)
  assert.ok(matches.items[0].snippet.startsWith('needle[0]'))
  assert.deepEqual(history(view, { operation: 'search', query: 'NEEDLE[0]' }, historyLimits).items.map(item => item.seq), [answer.seq])
  assert.deepEqual(history(view, { operation: 'search', query: 'needle[0]', window_id: checkpoint.seq }, historyLimits).items.map(item => item.seq), [newer.seq])
  assert.equal(history(view, { operation: 'search', query: 'reasoning phrase' }, historyLimits).items[0].seq, answer.seq)
  for (const query of ['.*', 'hidden-arguments', 'hidden-current-query', 'hidden-attempt', 'private metadata']) {
    assert.deepEqual(history(view, { operation: 'search', query }, historyLimits).items, [])
  }
  const first = history(view, { operation: 'search', query: 'needle[0]', limit: 1 }, historyLimits)
  assert.equal(first.has_more, true)
  const second = history(view, { operation: 'search', query: 'needle[0]', offset: first.next_offset, limit: 1 }, historyLimits)
  assert.equal(second.items[0].seq, newer.seq)
  assert.equal(second.has_more, false)
})

test('search uses message projection while read preserves the exact original event', () => {
  const view = logView()
  const original = user(view, 'original wording')
  user(view, 'invisible projection')
  view.deriveEventMessage = event => event.seq === original.seq
    ? { ...event.data, content: [{ type: 'text', text: 'projected wording' }] }
    : null
  assert.equal(history(view, { operation: 'search', query: 'projected' }, historyLimits).items[0].seq, original.seq)
  assert.deepEqual(history(view, { operation: 'search', query: 'original' }, historyLimits).items, [])
  assert.equal(history(view, { operation: 'list' }, historyLimits).items.length, 1)
  const page = history(view, { operation: 'read', seq: original.seq }, historyLimits)
  assert.equal(page.text, JSON.stringify(original))
  assert.deepEqual(JSON.parse(page.text), original)
})

test('bounded snippets and item pagination respect the serialized JSON output cap', () => {
  const view = logView()
  const events = Array.from({ length: 4 }, () => user(view, '"\\\n🙂'.repeat(300)))
  const limits = { maxResults: 2, maxOutputChars: 256 }
  let offset = 0
  const seen = []
  do {
    const page = history(view, { operation: 'list', offset }, limits)
    assert.ok(JSON.stringify(page).length <= limits.maxOutputChars)
    assert.ok(page.items.length > 0 && page.items.length <= limits.maxResults)
    assert.ok(page.items.every(item => item.snippet.length <= 240))
    seen.push(...page.items.map(item => item.seq))
    if (!page.has_more) {
      assert.equal(page.next_offset, null)
      break
    }
    assert.ok(page.next_offset > offset)
    offset = page.next_offset
    assert.ok(seen.length < events.length)
  } while (true)
  assert.deepEqual(seen, events.map(event => event.seq))
})

test('character-paged reads reconstruct full event JSON including metadata and escaped Unicode', () => {
  const view = logView()
  const event = view.append('tool/result', {
    message: {
      role: 'tool', isError: true,
      content: [{ type: 'text', text: '"\\\n🙂'.repeat(100) }],
    },
    meta: { exact: { nested: ['unchanged', 3, false] } },
    error: { name: 'Example', code: 'EXAMPLE', reason: 'preserve this too' },
  }, { sourceEventSeqs: [], surfaceOp: 'append' })
  const limits = { maxResults: 2, maxOutputChars: 256 }
  let offset = 0
  let collected = ''
  do {
    const page = history(view, { operation: 'read', seq: event.seq, offset, limit: 37 }, limits)
    assert.ok(JSON.stringify(page).length <= limits.maxOutputChars)
    assert.ok(page.text.length > 0 && page.text.length <= 37)
    assert.equal(page.offset, offset)
    assert.equal(page.total_chars, JSON.stringify(event).length)
    collected += page.text
    if (!page.has_more) {
      assert.equal(page.next_offset, null)
      break
    }
    assert.equal(page.next_offset, offset + page.text.length)
    offset = page.next_offset
    assert.ok(offset < page.total_chars)
  } while (true)
  assert.equal(collected, JSON.stringify(event))
  assert.deepEqual(JSON.parse(collected), event)
  const end = history(view, { operation: 'read', seq: event.seq, offset: collected.length }, limits)
  assert.equal(end.text, '')
  assert.equal(end.has_more, false)
})

test('history rejects invalid bounds, unknown windows and nonvisible event reads', () => {
  const { view, prompt, checkpoint, current } = conversation()
  for (const args of [
    { operation: 'unknown' },
    { operation: 'list', offset: -1 },
    { operation: 'list', offset: 0.5 },
    { operation: 'list', limit: 0 },
    { operation: 'list', limit: '1' },
    { operation: 'list', window_id: -2 },
    { operation: 'list', window_id: 1000 },
    { operation: 'search', query: '' },
    { operation: 'search', query: 1 },
    { operation: 'read' },
    { operation: 'read', seq: -1 },
    { operation: 'read', seq: current.seq },
    { operation: 'read', seq: 1000 },
    { operation: 'read', seq: prompt.seq, window_id: checkpoint.seq },
  ]) assert.throws(() => history(view, args, historyLimits))
  assert.throws(() => history(view, { operation: 'list' }, { maxResults: 1, maxOutputChars: 10 }), /maxOutputChars/)
  const empty = history(view, { operation: 'list', offset: 1000 }, historyLimits)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.next_offset, null)
  assert.equal(empty.has_more, false)
})
