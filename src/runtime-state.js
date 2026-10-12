import { z } from 'zod'
import { CHECKPOINT_SOURCE, REJECTED_SOURCE, stateMutation } from './state.js'

export const REMINDER_SOURCE = 'compaction-scroll-reminder'
const KEY = 'compaction-scroll-index'
const STATE_TOOLS = new Set(['scroll_notes_write', 'scroll_notes_append', 'new_context'])
const seq = z.number().int().min(0)
const reference = z.object({ seq, index: seq, id: z.string() })
const schema = z.object({
  notes: z.record(z.string(), z.object({ revision: seq, bytes: seq })),
  calls: z.record(z.string(), z.string()),
  pending: z.object({ seq, path: z.string(), revision: seq }).nullable(),
  lastResetSeq: z.number().int().min(-1),
  remindedSeq: z.number().int().min(-1),
  lastUser: seq.nullable(),
  lastAssistant: seq.nullable(),
  runtimeContext: seq.nullable(),
  systems: z.array(seq),
  unsettled: z.array(z.string()),
  inbox: z.object({ 'next-turn': z.array(reference), 'next-step': z.array(reference) }),
  claims: z.array(reference),
  error: z.string().nullable(),
})

function initial() {
  return {
    notes: {}, calls: {}, pending: null, lastResetSeq: -1, remindedSeq: -1,
    lastUser: null, lastAssistant: null, runtimeContext: null, systems: [], unsettled: [],
    inbox: { 'next-turn': [], 'next-step': [] }, claims: [], error: null,
  }
}

/** Persist references, never copies of original notes, input, schemas, or history. */
function reduce(state, event) {
  let next = state
  if (event.type === 'agent/inbox/spliced') {
    const { target, start, removedCount = 0, inserted, outcome } = event.data
    const pending = state.inbox[target]
    const removed = pending.slice(start, start + removedCount)
    const added = inserted.map((message, index) => ({ seq: event.seq, index, id: message.id }))
    const superseded = new Set(added.map(ref => ref.id))
    next = {
      ...state,
      inbox: { ...state.inbox, [target]: pending.toSpliced(start, removedCount, ...added) },
      claims: [...state.claims.filter(ref => !superseded.has(ref.id)), ...(outcome === 'canceled' ? [] : removed)],
    }
  }
  if (event.type === 'user/message') {
    const source = event.data.source.kind
    next = { ...next, claims: next.claims.filter(ref => ref.id !== event.data.id) }
    if (source === 'user') next.lastUser = event.seq
    if (source === 'runtime-context') next.runtimeContext = event.seq
    if (source === REMINDER_SOURCE) next.remindedSeq = event.seq
    if (source === CHECKPOINT_SOURCE && event.surfaceOp?.op === 'replace') {
      next.lastResetSeq = event.seq
      next.pending = null
    }
    if (source === REJECTED_SOURCE && event.sourceEventSeqs?.includes(next.pending?.seq)) next.pending = null
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
    // Record corruption in state, rather than breaking the shared registry's other folds.
    try {
      const meta = stateMutation(event, names, path => Object.hasOwn(next.notes, path) ? next.notes[path] : undefined)
      if (meta?.kind === 'note') next.notes = { ...next.notes, [meta.path]: { revision: event.seq, bytes: Buffer.byteLength(meta.text) } }
      if (meta?.kind === 'rollover') next.pending = { seq: event.seq, path: meta.path, revision: meta.revision }
    } catch (error) {
      next.error ??= error.message
    }
  }
  return next
}

export function registerRuntimeState(ctx) {
  ctx.sessionProjections.register({ key: KEY, stateVersion: 1, stateSchema: schema, init: initial, apply: reduce })
  return session => {
    const state = ctx.sessionProjections.stateOf(session, KEY)
    if (!state) throw new Error('compaction-scroll requires its session projection registration')
    return state
  }
}

export function referencedEvents(index) {
  return new Set([
    ...Object.values(index.notes).map(note => note.revision),
    ...index.claims.map(ref => ref.seq),
    ...Object.values(index.inbox).flatMap(refs => refs.map(ref => ref.seq)),
    index.lastUser, index.lastAssistant, index.runtimeContext, ...index.systems,
  ])
}
