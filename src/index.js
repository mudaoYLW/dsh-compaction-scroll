import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig } from './config.js'
import { createLogReader } from './log.js'
import { readState, prepareNote, readNote, listNotes, history } from './state.js'
import { registerRuntimeState } from './runtime-state.js'
import { createAdmission } from './admission.js'

export { Config }
export const name = 'compaction-scroll'
export const inject = ['tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'systemPrompt', 'tokenMeter']
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}
const mutationOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: value.kind === 'note'
    ? `Saved note ${JSON.stringify(value.path)} (${Buffer.byteLength(value.text)} UTF-8 bytes).`
    : 'Checkpoint accepted. The next safe request boundary will start a new context with this handoff; continue the task there.' }],
  presentationMeta: (_args, value) => ({ scroll: value }),
}
const pathParameter = { type: 'string', required: true, description: 'Session-private virtual note path, e.g. handoff.md. Not a workspace file.' }
const offsetParameter = { type: 'integer', description: 'Zero-based page offset; default 0.' }
const limitParameter = { type: 'integer', description: 'Page size, capped by plugin limits.' }

/** Register model tools and apply context replacement only after successful tool settlement. */
export function apply(ctx, input = {}) {
  const config = resolveConfig(input)
  if (ctx.get('compaction')) {
    throw new Error('compaction-scroll cannot run alongside an inherited compactor; disable compaction-basic for this mode')
  }
  ctx.systemPrompt.variable('scroll_checkpoint_path', () => config.checkpointPath)
  const indexOf = registerRuntimeState(ctx)
  const log = createLogReader(ctx, indexOf)
  const admission = createAdmission(ctx, config, log, indexOf)
  const register = (definition) => ctx.tools.register(defineTool(definition))
  const sessionFor = exec => {
    if (!exec.agent || exec.parent) throw new Error('This tool requires a direct call from an agent, not a nested tool transport')
    log.track(exec.agent.session)
    return exec.agent.session
  }
  const logFor = async exec => {
    const session = sessionFor(exec)
    exec.signal?.throwIfAborted()
    await log.flush(session)
    return log.state(session, exec.signal)
  }
  for (const append of [false, true]) {
    register({
      name: append ? 'scroll_notes_append' : 'scroll_notes_write',
      description: `${append ? 'Append to' : 'Replace'} a durable session-private note. Before new_context, update ${config.checkpointPath} with the goal, constraints, verified progress, next actions and history event references.`,
      parameters: { path: pathParameter, text: { type: 'string', required: true, description: 'Note text; append adds it verbatim without inserting a newline.' } },
      output: mutationOutput,
      execute: async (args, exec) => prepareNote(await logFor(exec), args, append, config),
    })
  }
  register({
    name: 'scroll_notes_read',
    description: 'Read a saved note after a context reset. Line ranges are 1-based inclusive; character offsets page within the selected range.',
    parameters: { path: pathParameter, start_line: { type: 'integer' }, stop_line: { type: 'integer' }, offset: offsetParameter, limit: limitParameter },
    output: textOutput,
    execute: async (args, exec) => {
      const note = readNote(await logFor(exec), args)
      const offset = integer(args.offset ?? 0, 'offset', 0)
      const limit = Math.min(integer(args.limit ?? config.maxOutputChars, 'limit', 1), config.maxOutputChars)
      const end = Math.min(note.text.length, offset + limit)
      return JSON.stringify({ ...note, text: note.text.slice(offset, end), offset, next_offset: end < note.text.length ? end : null, has_more: end < note.text.length })
    },
  })
  register({
    name: 'scroll_notes_list',
    description: 'List current session notes. Notes survive context resets, process restarts and session forks.',
    parameters: { prefix: { type: 'string' }, offset: offsetParameter, limit: limitParameter },
    output: textOutput,
    execute: async (args, exec) => {
      const notes = listNotes(await logFor(exec), args)
      const offset = integer(args.offset ?? 0, 'offset', 0)
      const limit = Math.min(integer(args.limit ?? config.maxResults, 'limit', 1), config.maxResults)
      return JSON.stringify({ notes: notes.slice(offset, offset + limit), next_offset: offset + limit < notes.length ? offset + limit : null })
    },
  })
  register({
    name: 'scroll_history',
    description: 'Retrieve original current-session history, including windows removed from model context. List windows/items, search a case-sensitive literal substring, then read an event by seq. Read offsets count characters; other offsets count results.',
    parameters: {
      operation: { type: 'string', enum: ['windows', 'list', 'search', 'read'], required: true },
      window_id: { type: 'integer', description: 'Checkpoint event seq; -1 is the initial window. Omit to query all windows.' },
      seq: { type: 'integer', description: 'Exact original event ID for read.' },
      query: { type: 'string', description: 'Literal substring for search.' },
      offset: offsetParameter, limit: limitParameter,
    },
    output: textOutput,
    execute: async (args, exec) => JSON.stringify(history(await log.history(sessionFor(exec), exec.signal), args, config)),
  })
  register({
    name: 'get_context_remaining',
    description: 'Report remaining configured working-context budget, using the Harness token meter (provider usage plus estimates). This is not the model advertised maximum.',
    parameters: {}, output: textOutput,
    execute: async (_args, exec) => {
      await logFor(exec)
      const measurement = ctx.tokenMeter.measure(exec.agent.session)
      return JSON.stringify({ tokens_left: Math.max(0, config.contextBudgetTokens - measurement.totalTokens), used_tokens: measurement.totalTokens, budget_tokens: config.contextBudgetTokens, baseline: measurement.baseline.kind })
    },
  })
  register({
    name: 'new_context',
    description: `Start a fresh context WITHOUT automatic summarization. First save a current, complete handoff to ${config.checkpointPath}. Call new_context alone, with no other tool calls in this response. The saved handoff is injected automatically; original history remains retrievable.`,
    parameters: {}, output: mutationOutput,
    execute: async (_args, exec) => {
      const view = await logFor(exec)
      const state = readState(view)
      const note = requireCheckpoint(state, config)
      const assistantSeq = indexOf(exec.agent.session).lastAssistant
      const lastAssistant = assistantSeq === null ? null : await log.event(exec.agent.session, assistantSeq, exec.signal)
      const calls = lastAssistant?.data.message.content.filter(block => block.type === 'tool-call') ?? []
      if (calls.length !== 1 || calls[0].name !== 'new_context' || calls[0].id !== exec.callId) {
        throw new Error('new_context must be the only tool call in its assistant response; write the checkpoint in the preceding response')
      }
      await admission.validate(exec.agent, { path: config.checkpointPath, revision: note.revision }, note, exec.signal)
      return { version: 1, kind: 'rollover', path: config.checkpointPath, revision: note.revision }
    },
  })
}

function requireCheckpoint(state, config) {
  const note = state.notes.get(config.checkpointPath)
  if (!note || !note.text.trim() || note.revision <= state.lastResetSeq) {
    throw new Error(`Write a fresh nonempty ${config.checkpointPath} in this window before calling new_context`)
  }
  if (note.text.length > config.maxCheckpointChars) {
    throw new Error(`Handoff exceeds maxCheckpointChars (${config.maxCheckpointChars}); shorten it before new_context`)
  }
  return note
}

function integer(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}
