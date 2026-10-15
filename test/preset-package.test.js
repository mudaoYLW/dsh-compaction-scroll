import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import * as Persona from '@deepseek-ai/dsh-persona'
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createMinimalNotesPreset } from '../presets/minimal-notes.js'
import { resolveConfig } from '../src/config.js'
import * as Scroll from '../src/index.js'
import { runtime } from './support/runtime.js'

const checkpointPaths = ['notes/$&.md', 'notes/{{unknown}}.md', 'notes/{{scroll_checkpoint_path}}.md']

test('configuration exposes a soft working target and bounded note/history quotas', () => {
  assert.deepEqual(resolveConfig(), {
    contextBudgetTokens: 64000,
    reminderTokens: 8000,
    checkpointPath: 'handoff.md',
    maxCheckpointChars: 16000,
    maxNoteBytes: 65536,
    maxNotes: 64,
    maxTotalNoteBytes: 262144,
    maxResults: 20,
    maxOutputChars: 12000,
  })
})

test('configuration preserves reminder and durable note quota invariants', () => {
  assert.throws(() => resolveConfig({ reminderTokens: 64000 }), /reminderTokens must be smaller/)
  assert.throws(() => resolveConfig({ maxCheckpointChars: 65537 }), /maxCheckpointChars must not exceed maxNoteBytes/)
  assert.throws(() => resolveConfig({ maxNoteBytes: 262145 }), /maxNoteBytes must not exceed maxTotalNoteBytes/)
})

for (const checkpointPath of checkpointPaths) {

  test(`published persona renders the runtime checkpoint path literally: ${checkpointPath}`, async () => {
    const config = resolveConfig({ checkpointPath, maxCheckpointChars: 1234 })
    const definition = createMinimalNotesPreset(config)
    const persona = definition.plugins.find(plugin => plugin.id === 'persona')
    const scroll = definition.plugins.find(plugin => plugin.id === 'compaction-scroll')
    const r = await runtime(() => [], { mountScroll: false })
    let scope
    try {
      const key = {}
      scope = createScope(r.ctx, key)
      await scope.ctx.plugin(Scroll, scroll.config)
      await scope.ctx.plugin(Persona, persona.config)
      const assembly = await r.ctx.systemPrompt.assemble({ scope: key })
      const rendered = renderPrompt(assembly)
      assert.equal(assembly.variables.scroll_checkpoint_path, checkpointPath)
      assert.ok(rendered.includes(checkpointPath))
    } finally {
      await scope?.dispose()
      await r.close()
    }
  })
}


test('official compatibility admission allows only the pinned DSH host', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const supported = '0.2.0-rc.2'
  assert.equal(evaluatePluginCompatibility(manifest, {}, supported), undefined)
  for (const version of ['0.1.0', '0.2.0-rc.1', '0.2.0-rc.3', '0.2.0', '0.3.0-alpha.1']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, `Host ${version} must be rejected`)
    assert.equal(issue.exempted, false)
  }
})
