import { Buffer } from 'node:buffer'

export const CHECKPOINT_SOURCE = 'compaction-scroll-checkpoint'
export const REJECTED_SOURCE = 'compaction-scroll-rejected'
const NOTE_TOOLS = new Set(['scroll_notes_write', 'scroll_notes_append'])
const STATE_TOOLS = new Set([...NOTE_TOOLS, 'new_context'])
const HISTORY_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const states = new WeakMap()
const SNIPPET_CHARS = 240

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

/** Validate a bounded, session-private virtual note name (never a filesystem path). */
export function notePath(path) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path, 'utf8') > 512 || path.includes('\\')
    || /^[a-zA-Z]:/.test(path) || /[\u0000-\u001f\u007f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('path must be a relative virtual note path of at most 512 UTF-8 bytes, without empty, . or .. segments, backslashes, drive prefixes or control characters')
  }
  return path
}

function checkpoint(event) {
  return event.type === 'user/message'
    && event.data?.source?.kind === CHECKPOINT_SOURCE
    && event.surfaceOp?.op === 'replace'
}

function corruption(event, message, cause) {
  return new Error(`Scroll state corruption at event ${event.seq}: ${message}`, { cause })
}

/** Decode only successful mutations linked to this plugin's original tool calls. */
export function stateMutation(event, names, getNote) {
  if (event.type !== 'tool/result' || event.data.message?.isError !== false || !names.length) return null
  const meta = event.data.meta?.scroll
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.version !== 1) {
    throw corruption(event, 'expected version 1 scroll metadata from the successful state tool')
  }
  try {
    notePath(meta.path)
  } catch (error) {
    throw corruption(event, error.message, error)
  }

  if (meta.kind === 'note' && names.every(name => NOTE_TOOLS.has(name))) {
    if (typeof meta.text !== 'string') throw corruption(event, 'note text must be a string')
    return meta
  }
  if (meta.kind === 'rollover' && names.every(name => name === 'new_context')) {
    const note = getNote(meta.path)
    if (!Number.isSafeInteger(meta.revision) || meta.revision < 0
      || !note || note.revision !== meta.revision) {
      throw corruption(event, 'rollover must reference the existing note revision at its original result sequence')
    }
    return meta
  }
  throw corruption(event, 'scroll metadata kind does not match its referenced source tool/call')
}

function consume(cache, event) {
  if (checkpoint(event)) {
    cache.state.lastResetSeq = event.seq
    cache.state.pending = null
    return
  }
  if (event.type === 'user/message' && event.data.source?.kind === REJECTED_SOURCE
    && event.sourceEventSeqs?.includes(cache.state.pending?.seq)) {
    cache.state.pending = null
    return
  }
  if (event.type === 'tool/call') {
    if (STATE_TOOLS.has(event.data.name)) cache.calls.set(event.seq, event.data.name)
    return
  }
  if (event.type !== 'tool/result') return
  const names = (event.sourceEventSeqs ?? []).map(seq => cache.calls.get(seq)).filter(name => name !== undefined)
  const meta = stateMutation(event, names, path => cache.state.notes.get(path))
  for (const seq of event.sourceEventSeqs ?? []) cache.calls.delete(seq)
  if (!meta) return
  if (meta.kind === 'note') {
    const previous = cache.state.notes.get(meta.path)
    cache.totalBytes += Buffer.byteLength(meta.text, 'utf8') - (previous ? Buffer.byteLength(previous.text, 'utf8') : 0)
    cache.state.notes.set(meta.path, Object.freeze({ text: meta.text, revision: event.seq }))
  } else {
    cache.state.pending = Object.freeze({ seq: event.seq, path: meta.path, revision: meta.revision })
  }
}

function folded(session) {
  if (session.scrollState) return { state: session.scrollState, totalBytes: session.scrollTotalBytes }
  let cache = states.get(session)
  if (!cache || session.seq < cache.cursor) {
    cache = {
      cursor: 0,
      calls: new Map(),
      totalBytes: 0,
      state: { notes: new Map(), pending: null, lastResetSeq: -1 },
    }
    states.set(session, cache)
  }
  if (cache.cursor === session.seq) return cache
  // This is the persistence-backed log view, never the host's deprecated sync reader.
  for (const event of session.snapshotEvents(cache.cursor)) {
    consume(cache, event)
    // Advance per accepted event so a corrupt next event cannot replay earlier writes.
    cache.cursor = event.seq + 1
  }
  return cache
}

/**
 * Fold only newly committed original events from a persistence-backed log view.
 * The view supplies seq, snapshotEvents(from?, to?) and optional deriveEventMessage.
 * Revisions are note-result event seqs, not write counts. The returned cache and
 * Map are borrowed: callers must not mutate them. A new view replays identically.
 */
export function readState(session) {
  return folded(session).state
}

/** Prepare full replacement metadata without changing state or writing any event. */
export function prepareNote(session, { path, text }, append, limits) {
  notePath(path)
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (typeof append !== 'boolean') throw new TypeError('append must be a boolean')
  const maxNoteBytes = integer(limits.maxNoteBytes, 'maxNoteBytes', 1)
  const maxNotes = integer(limits.maxNotes, 'maxNotes', 1)
  const maxTotalNoteBytes = integer(limits.maxTotalNoteBytes, 'maxTotalNoteBytes', 1)
  const cache = folded(session)
  const previous = cache.state.notes.get(path)
  const content = append ? (previous?.text ?? '') + text : text
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxNoteBytes) throw new RangeError(`note exceeds maxNoteBytes (${maxNoteBytes} UTF-8 bytes)`)
  if (!previous && cache.state.notes.size >= maxNotes) {
    throw new RangeError(`session exceeds maxNotes (${maxNotes})`)
  }
  const totalBytes = cache.totalBytes + bytes - (previous ? Buffer.byteLength(previous.text, 'utf8') : 0)
  if (totalBytes > maxTotalNoteBytes) {
    throw new RangeError(`session notes exceed maxTotalNoteBytes (${maxTotalNoteBytes} UTF-8 bytes)`)
  }
  return { version: 1, kind: 'note', path, text: content }
}

/**
 * Read LF-delimited lines using 1-based inclusive positive bounds. Omitted bounds
 * mean the beginning/end; bounds past EOF are clamped. CR characters are preserved,
 * and a trailing LF creates an empty final line. No bounds returns the exact text.
 */
export function readNote(session, { path, start_line, stop_line }) {
  notePath(path)
  const start = start_line === undefined ? 1 : integer(start_line, 'start_line', 1)
  const stop = stop_line === undefined ? undefined : integer(stop_line, 'stop_line', 1)
  if (stop !== undefined && stop < start) throw new RangeError('stop_line must be >= start_line')
  const note = readState(session).notes.get(path)
  if (!note) throw new Error(`note not found: ${path}`)
  const text = start_line === undefined && stop_line === undefined
    ? note.text
    : note.text.split('\n').slice(start - 1, stop).join('\n')
  return { path, revision: note.revision, text }
}

/** List paths in deterministic lexical order, optionally matching a literal prefix. */
export function listNotes(session, { prefix = '' } = {}) {
  if (typeof prefix !== 'string') throw new TypeError('prefix must be a string')
  const notes = []
  for (const [path, note] of readState(session).notes) {
    if (path.startsWith(prefix)) {
      notes.push({ path, revision: note.revision, bytes: Buffer.byteLength(note.text, 'utf8') })
    }
  }
  return notes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function windowsOf(events) {
  const windows = [{ window_id: -1, start_seq: 0, end_seq: -1, event_count: 0, current: true }]
  let window = windows[0]
  for (const event of events) {
    if (checkpoint(event)) {
      window.end_seq = event.seq - 1
      window.current = false
      window = { window_id: event.seq, start_seq: event.seq, end_seq: event.seq, event_count: 0, current: true }
      windows.push(window)
    }
    window.end_seq = event.seq
    if (HISTORY_TYPES.has(event.type)) window.event_count++
  }
  return windows
}

function messageText(session, event) {
  const message = typeof session.deriveEventMessage === 'function'
    ? session.deriveEventMessage(event)
    : event.type === 'user/message' ? event.data : event.data.message
  if (!message) return null
  // Search prose, not tool-call arguments, attachment encodings or internal metadata.
  return message.content
    .filter(block => block.type === 'text' || block.type === 'reasoning')
    .map(block => block.text)
    .join('\n')
}

function* historyRows(session, events, windows, selected, query) {
  let windowIndex = 0
  for (const event of events) {
    while (windowIndex + 1 < windows.length && event.seq >= windows[windowIndex + 1].start_seq) {
      windowIndex++
    }
    const window = windows[windowIndex]
    if (selected && window !== selected) continue
    if (!HISTORY_TYPES.has(event.type)) continue
    const text = messageText(session, event)
    if (text === null) continue
    const match = query === undefined ? 0 : text.indexOf(query)
    if (match < 0) continue
    const row = { seq: event.seq, window_id: window.window_id, type: event.type }
    if (query !== undefined) row.match_offset = match
    row.snippet = text.slice(match, match + SNIPPET_CHARS)
    yield row
  }
}

function serializedSize(value) {
  return JSON.stringify(value).length
}

function checkOutput(value, maxOutputChars) {
  if (serializedSize(value) > maxOutputChars) {
    throw new RangeError('maxOutputChars is too small for the history response metadata')
  }
  return value
}

function pageRows(operation, rows, offset, limit, maxOutputChars) {
  const iterator = rows[Symbol.iterator]()
  let next = iterator.next()
  for (let skipped = 0; skipped < offset && !next.done; skipped++) next = iterator.next()
  const page = { operation, items: [], offset, next_offset: null, has_more: false }
  checkOutput(page, maxOutputChars)
  while (!next.done && page.items.length < limit) {
    const following = iterator.next()
    const candidate = {
      ...page,
      items: [...page.items, next.value],
      next_offset: following.done ? null : offset + page.items.length + 1,
      has_more: !following.done,
    }
    if (serializedSize(candidate) > maxOutputChars) {
      if (page.items.length) break
      if (typeof next.value.snippet !== 'string') {
        throw new RangeError('maxOutputChars is too small for one history item')
      }
      const original = next.value.snippet
      let low = 0
      let high = original.length
      next.value.snippet = ''
      checkOutput(candidate, maxOutputChars)
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        next.value.snippet = original.slice(0, middle)
        if (serializedSize(candidate) <= maxOutputChars) low = middle
        else high = middle - 1
      }
      next.value.snippet = original.slice(0, low)
    }
    page.items = candidate.items
    page.next_offset = candidate.next_offset
    page.has_more = candidate.has_more
    next = following
  }
  return page
}

function readHistory(event, window, offset, limit, maxOutputChars) {
  const json = JSON.stringify(event)
  const page = {
    operation: 'read',
    seq: event.seq,
    window_id: window.window_id,
    offset,
    text: '',
    total_chars: json.length,
    next_offset: offset < json.length ? offset : null,
    has_more: offset < json.length,
  }
  checkOutput(page, maxOutputChars)
  let low = 0
  let high = Math.min(limit, Math.max(0, json.length - offset))
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    page.text = json.slice(offset, offset + middle)
    page.has_more = offset + middle < json.length
    page.next_offset = page.has_more ? offset + middle : null
    if (serializedSize(page) <= maxOutputChars) low = middle
    else high = middle - 1
  }
  page.text = json.slice(offset, offset + low)
  page.has_more = offset + low < json.length
  page.next_offset = page.has_more ? offset + low : null
  if (page.has_more && !low) throw new RangeError('maxOutputChars is too small for one history character')
  return page
}

/**
 * Query this persistence-backed session log view, including shadowed messages.
 * Window IDs are checkpoint seqs, with -1 for the initial window. A checkpoint
 * belongs to the new window. list/search/windows offset and limit count items;
 * read offset and limit count UTF-16 code units of JSON.stringify(originalEvent).
 * Concatenate read.text pages to recover the exact complete event JSON. Search
 * is literal and case-sensitive over projected text/reasoning, never tool-call
 * arguments. Every returned JSON object fits maxOutputChars after serialization.
 */
export function history(session, args, { maxResults, maxOutputChars }) {
  integer(maxResults, 'maxResults', 1)
  integer(maxOutputChars, 'maxOutputChars', 1)
  const { operation, window_id, seq, query } = args
  if (!['windows', 'list', 'search', 'read'].includes(operation)) {
    throw new TypeError('operation must be windows, list, search or read')
  }
  const offset = args.offset === undefined ? 0 : integer(args.offset, 'offset')
  const cap = operation === 'read' ? maxOutputChars : maxResults
  const limit = args.limit === undefined ? cap : Math.min(integer(args.limit, 'limit', 1), cap)
  if (window_id !== undefined) integer(window_id, 'window_id', -1)
  if (operation === 'search' && (typeof query !== 'string' || !query.length)) {
    throw new TypeError('search query must be a nonempty string')
  }
  const events = session.snapshotEvents()
  const windows = windowsOf(events)
  const selected = window_id === undefined ? undefined : windows.find(window => window.window_id === window_id)
  if (window_id !== undefined && !selected) throw new Error(`history window not found: ${window_id}`)
  if (operation === 'windows') {
    return pageRows(operation, selected ? [selected] : windows, offset, limit, maxOutputChars)
  }
  if (operation === 'read') {
    integer(seq, 'seq')
    const event = events[seq]
    if (!event || !HISTORY_TYPES.has(event.type)) throw new Error(`visible history event not found: ${seq}`)
    const window = windows.find(window => seq >= window.start_seq && seq <= window.end_seq)
    if (selected && window !== selected) throw new Error(`event ${seq} is not in history window ${window_id}`)
    return readHistory(event, window, offset, limit, maxOutputChars)
  }
  return pageRows(operation, historyRows(session, events, windows, selected, operation === 'search' ? query : undefined), offset, limit, maxOutputChars)
}
