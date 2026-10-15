import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'

// rc.2 ships these pure definitions only inside its browser bundle. Execute
// their unmodified module regions rather than copying the classifier logic;
// no DOM renderer or replacement implementation is involved in this fixture.
function region(bundle, name) {
  const start = bundle.indexOf(`//#region ${name}`)
  const end = bundle.indexOf('//#endregion', start)
  if (start < 0 || end < 0) throw new Error(`Pinned native UI module unavailable: ${name}`)
  return bundle.slice(start, end)
}
export async function nativeInputProjections() {
  const [chat, trajectory] = await Promise.all([
    readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-chat/client')), 'utf8'),
    readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-trajectory/client')), 'utf8'),
  ])
  return {
    chat: vm.runInNewContext([
      region(chat, 'lib/types/client/conversation-nodes/inbox.js'),
      region(chat, 'lib/types/client/conversation-nodes/message.js'),
      '({ inboxes: [nextStepInboxDefinition, nextTurnInboxDefinition], message: messageDefinition })',
    ].join('\n'), { isAppendSurfaceEvent, isReplacementSurfaceEvent }),
    trajectory: vm.runInNewContext([
      region(trajectory, 'lib/types/client/trajectory-message-definitions.js'),
      '({ inboxes: [trajectoryInboxDefinition], message: trajectoryMessageDefinition })',
    ].join('\n')),
  }
}
export function classifyHumanInputs(definitions, events) {
  const records = new Map()
  const result = new Map()
  const reader = { previous: kind => records.get(kind) }
  for (const event of events) {
    for (const definition of definitions.inboxes) {
      if (definition.match(event)) records.set(definition.kind, { state: definition.start(null, { event }, reader) })
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user' && definitions.message.match(event)) {
      result.set(event.data.id, definitions.message.start(null, { event }, reader).kind)
    }
  }
  return result
}
