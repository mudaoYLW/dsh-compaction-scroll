import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { CHECKPOINT_SOURCE, REJECTED_SOURCE, stateMutation } from './state.js'

const KEY = 'compaction-scroll-index'
const STATE_TOOLS = new Set(['scroll_notes_write', 'scroll_notes_append', 'new_context'])
const LEGACY_CONTROL_SOURCES = new Set([
  'compaction-scroll-control', 'compaction-scroll-release',
  'compaction-scroll-admitted', 'compaction-scroll-admission-decision',
])
const seq = z.number().int().min(0)
const schema = z.object({
  inheritedEventCount: seq,
  notes: z.record(z.string(), z.object({ revision: seq, bytes: seq })),
  calls: z.record(z.string(), z.string()),
  pending: z.object({ seq, path: z.string(), revision: seq }).nullable(),
  lastResetSeq: z.number().int().min(-1),
  lastUser: seq.nullable(),
  lastAssistant: seq.nullable(),
  runtimeContext: seq.nullable(),
  systems: z.array(seq),
  unsettled: z.array(z.string()),
  error: z.string().nullable(),
})

/** Historical metadata is readable evidence, never a new model input. */
export function isLegacyControl(message) {
  return LEGACY_CONTROL_SOURCES.has(message.source?.kind)
}

function initial(_header, inheritedEventCount = 0) {
  return {
    inheritedEventCount,
    notes: {}, calls: {}, pending: null, lastResetSeq: -1,
    lastUser: null, lastAssistant: null, runtimeContext: null, systems: [], unsettled: [], error: null,
  }
}

/** Keep only references to notes and the active context; native inputs stay native. */
function reduce(state, event) {
  let next = state
  if (event.type === 'user/message') {
    next = { ...next }
    const source = event.data.source
    if (source.kind === 'user') next.lastUser = event.seq
    if (source.kind === 'runtime-context') next.runtimeContext = event.seq
    if (source.kind === CHECKPOINT_SOURCE && event.surfaceOp?.op === 'replace') {
      next.lastResetSeq = event.seq
      next.pending = null
    }
    if (source.kind === REJECTED_SOURCE && event.sourceEventSeqs?.includes(next.pending?.seq)) next.pending = null
  }
  if (event.surfaceOp?.op === 'replace') {
    const removed = new Set(event.sourceEventSeqs ?? [])
    next = { ...next, systems: next.systems.filter(value => !removed.has(value)) }
    if (removed.has(next.runtimeContext)) next.runtimeContext = null
  }
  if (event.type === 'system/message') next = { ...next, systems: [...next.systems, event.seq] }
  if (event.type === 'assistant/message') {
    next = { ...next, lastAssistant: event.seq, unsettled: [...next.unsettled,
      ...event.data.message.content.filter(block => block.type === 'tool-call').map(block => block.id)] }
  }
  if (event.type === 'tool/call' && STATE_TOOLS.has(event.data.name)) {
    next = { ...next, calls: { ...next.calls, [event.seq]: event.data.name } }
  }
  if (event.type === 'tool/result') {
    const names = (event.sourceEventSeqs ?? []).map(value => next.calls[value]).filter(value => value !== undefined)
    const calls = { ...next.calls }
    for (const value of event.sourceEventSeqs ?? []) delete calls[value]
    next = { ...next, calls, unsettled: next.unsettled.filter(id => id !== event.data.message.toolCallId) }
    // Corruption must not interrupt the shared registry's other projections.
    try {
      const meta = stateMutation(event, names, path => Object.hasOwn(next.notes, path) ? next.notes[path] : undefined)
      if (meta?.kind === 'note') next.notes = { ...next.notes, [meta.path]: { revision: event.seq, bytes: Buffer.byteLength(meta.text) } }
      if (meta?.kind === 'rollover' && event.seq >= state.inheritedEventCount) next.pending = { seq: event.seq, path: meta.path, revision: meta.revision }
    } catch (error) {
      next.error ??= error.message
    }
  }
  // A fork inherits notes and evidence, not the parent's pending rollover.
  if (event.type === 'session/end-seed' && event.data.inherited === true) {
    next = { ...next, pending: null, lastResetSeq: event.seq }
  }
  return next
}

export function registerRuntimeState(ctx) {
  // Version changes refold the unchanged original log rather than restoring old control state.
  ctx.sessionProjections.register({ key: KEY, stateVersion: 7, stateSchema: schema, init: initial, apply: reduce })
  return session => {
    const state = ctx.sessionProjections.stateOf(session, KEY)
    if (!state) throw new Error('compaction-scroll requires its session projection registration')
    return state
  }
}

export function referencedEvents(index) {
  return new Set([
    ...Object.values(index.notes).map(note => note.revision),
    index.lastUser, index.lastAssistant, index.runtimeContext, ...index.systems,
  ].filter(value => value !== null))
}
