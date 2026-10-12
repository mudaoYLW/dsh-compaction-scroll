import { referencedEvents } from './runtime-state.js'

/** Sparse live references plus on-demand durable reads; no synchronous Session log APIs. */
export function createLogReader(ctx, indexOf) {
  const live = new WeakMap()
  const track = session => {
    let events = live.get(session)
    if (!events) live.set(session, events = new Map())
    return events
  }
  ctx.on('session/event', (session, event) => {
    const events = live.get(session)
    if (events && ['agent/inbox/spliced', 'user/message', 'system/message', 'assistant/message', 'tool/result'].includes(event.type)) {
      events.set(event.seq, event)
    }
  }, { global: true })

  const flush = async session => {
    if (!await ctx.sessions.flush(session)) {
      throw new Error('compaction-scroll requires a durable session writer; context was not cleared')
    }
  }
  const stored = async (session, from, count, signal) => {
    const handle = await ctx.sessionPersistence.open(session.id, 'read', { signal })
    try {
      const { events } = await handle.read(from, count, { signal })
      if (events.length !== count || events.some((event, offset) => event.seq !== from + offset)) {
        throw new Error('Durable session log is incomplete; context was not cleared')
      }
      return events
    } finally {
      await handle.close()
    }
  }
  const event = async (session, seq, signal) => {
    signal?.throwIfAborted()
    const events = track(session)
    if (events.has(seq)) return events.get(seq)
    const [value] = await stored(session, seq, 1, signal)
    events.set(seq, value)
    return value
  }
  const state = async (session, signal) => {
    const index = indexOf(session)
    if (index.error) throw new Error(index.error)
    const events = track(session)
    const needed = referencedEvents(index)
    for (const seq of events.keys()) if (!needed.has(seq)) events.delete(seq)
    const notes = new Map()
    let totalBytes = 0
    for (const [path, note] of Object.entries(index.notes)) {
      const original = await event(session, note.revision, signal)
      notes.set(path, Object.freeze({ text: original.data.meta.scroll.text, revision: note.revision }))
      totalBytes += note.bytes
    }
    return {
      scrollState: { notes, pending: index.pending, lastResetSeq: index.lastResetSeq },
      scrollTotalBytes: totalBytes,
    }
  }
  const history = async (session, signal) => {
    signal?.throwIfAborted()
    await flush(session)
    const events = await stored(session, 0, session.seq, signal)
    return {
      events, seq: events.length,
      snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
      deriveEventMessage: event => session.deriveEventMessage(event),
    }
  }
  return { track, event, state, history, flush }
}
