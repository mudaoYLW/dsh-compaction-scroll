// Copied to a temporary directory by packed-runtime.test.js; never import repository code here.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [installAnchor, profileDir, workspace] = process.argv.slice(2)
const hostRequire = createRequire(installAnchor)
const fromHost = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const { boot, createRuntimeResolution, loadProfileDirectory, PluginPackages } = await fromHost('@deepseek-ai/dsh-app-boot')
const { LlmAdapter, createUserMessage } = await fromHost('@deepseek-ai/dsh-llm')
const packageName = 'dsh-compaction-scroll'
const pluginDir = await realpath(join(profileDir, 'node_modules', packageName))
assert.equal(pluginDir, join(profileDir, 'node_modules', packageName), 'profile plugin must be extracted from the tarball, not linked to the repository')
const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
const profile = loadProfileDirectory('packed-runtime', profileDir, installAnchor)
assert.deepEqual(profile.skippedBundles, [])
assert.equal(profile.layers.length, 1)
assert.equal(profile.layers[0].packageName, packageName)
assert.equal(await realpath(profile.layers[0].packageDir), pluginDir)
const resolution = await createRuntimeResolution({ installAnchor, profile, home: process.env.DSH_HOME })
assert.ok(resolution.localPackageNames.includes(packageName))
assert.equal(resolution.entries.some(entry => entry.name === packageName && entry.scope === 'installation'), false)
assert.deepEqual(resolution.linkedRoots, [], 'profile must have a real installed package, not a development link')

const configPath = join(profileDir, 'cordis.json')
const entry = (id, name, config) => ({ id, name: `@deepseek-ai/${name}`, ...(config === undefined ? {} : { config }) })
await writeFile(configPath, JSON.stringify([
  entry('sessions', 'dsh-session'),
  entry('session-projections', 'dsh-session-projection'),
  entry('llm', 'dsh-llm'),
  entry('agents', 'dsh-agent'),
  entry('system-prompt', 'dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: true }),
  entry('tools', 'dsh-tools', { mode: 'native' }),
  entry('session-persistence', 'dsh-session-persistence-jsonl', { root: join(workspace, 'sessions'), compression: 'none' }),
  entry('token-meter', 'dsh-token-meter'),
  entry('agent-loop', 'dsh-agent-loop'),
  entry('agent-presets', 'dsh-agent-preset-registry', { default: 'minimal-notes' }),
  entry('session-query', 'dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' }),
  entry('subprocess', 'dsh-subprocess-local'),
  // Only a fixed printf command runs. Avoid requiring a platform sandbox helper for this packaging regression.
  entry('sandbox-policy', 'dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: workspace }),
  entry('approval', 'dsh-user-approval', { policy: 'never' }),
  entry('subagents', 'dsh-subagent'),
  entry('subagent-spawn', 'dsh-subagent-spawn-in-process', { providerName: 'spawn' }),
]))

const profileContext = {
  name: profile.name, dir: profileDir, patchPath: profile.patchPath, installAnchor,
  cwd: workspace, home: process.env.DSH_HOME,
  startedBundles: [packageName], overlays: [], telemetryDisabledEnv: '1',
}
const failures = []
let ctx
try {
  ctx = await boot('packed-runtime', configPath, profile.layers.flatMap(layer => layer.patches), async host => {
    host.provide('profileContext', profileContext)
    await host.plugin(PluginPackages, { resolution })
    host.on('agent/error', ({ error }) => { failures.push(error) })
  })
  const preset = await ctx.agentPresets.resolve('minimal-notes')
  assert.equal(preset.broken, undefined, preset.broken)
  const loader = ctx.loader.internal
  assert.ok(loader, 'the official Node module loader must be active')
  const profileURL = pathToFileURL(configPath).href
  const resolveModule = (name, parentURL) => loader.version === 'v1'
    ? loader.resolveSync(name, parentURL, {}).url
    : loader.resolveSync(parentURL, { specifier: name, attributes: {} }).url
  const modulePaths = {}
  for (const [specifier, exportName] of [[packageName, '.'], [`${packageName}/preset`, './preset']]) {
    const url = resolveModule(specifier, profileURL)
    const path = await realpath(fileURLToPath(url))
    assert.equal(path, await realpath(join(pluginDir, manifest.exports[exportName])))
    assert.ok(path.startsWith(pluginDir + sep), `${specifier} escaped its profile install`)
    assert.ok(loader.loadCache.get(url), `${specifier} must already have been loaded by the published bundle/preset`)
    modulePaths[specifier] = path
  }

  const pluginURL = pathToFileURL(modulePaths[packageName]).href
  const runtimePeers = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-token-meter/estimate', '@deepseek-ai/dsh-tools']
  const peerPaths = {}
  for (const name of runtimePeers) {
    const hostPath = await realpath(hostRequire.resolve(name))
    const pluginPath = await realpath(fileURLToPath(resolveModule(name, pluginURL)))
    assert.equal(pluginPath, hostPath, `${name} must have host module identity from the installed plugin`)
    peerPaths[name] = pluginPath
  }

  const marker = 'SCROLL_PACKED_BASH_OK'
  const notePath = 'packed-install.md'
  const noteText = `The package-installed preset executed the native shell: ${marker}`
  const calls = [
    { name: 'bash', arguments: { command: `printf '%s\\n' '${marker}'` } },
    { name: 'scroll_notes_write', arguments: { path: notePath, text: noteText } },
    { name: 'scroll_notes_read', arguments: { path: notePath } },
  ]
  const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  let requests = 0
  class ScriptedAdapter extends LlmAdapter {
    async *stream(options) {
      const step = requests++
      assert.ok(step <= calls.length, 'unexpected additional provider request')
      if (step > 0) {
        const result = options.messages.findLast(message => message.role === 'tool')
        assert.ok(result, 'each native tool must settle before the next request')
        assert.equal(result.toolCallId, `packed-call-${step}`)
        assert.equal(result.isError, false, textOf(result))
        if (step === 1) {
          assert.ok(textOf(result).includes(marker))
        } else if (step === 3) {
          const note = JSON.parse(textOf(result))
          assert.equal(note.path, notePath)
          assert.equal(note.text, noteText)
        }
      }
      const block = step < calls.length
        ? { type: 'tool-call', id: `packed-call-${step + 1}`, name: calls[step].name, arguments: JSON.stringify(calls[step].arguments) }
        : { type: 'text', text: 'Packed preset bash and notes completed.' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['packed-scripted'], new ScriptedAdapter())
  const { agent } = await ctx.agents.create({
    sessionId: 'packed-notes-agent',
    meta: { cwd: workspace, agentPreset: 'minimal-notes' },
    agentOptions: { provider: 'packed-scripted', model: 'offline' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'minimal-notes') },
  })
  agent.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Run the harmless bash command, write its evidence to a virtual note, then read the note.' }],
  }))
  await agent.whenIdle()
  assert.equal(failures.length, 0, failures.map(error => error?.stack ?? String(error)).join('\n'))
  assert.equal(requests, 4)
  await ctx.sessions.flush(agent.session)
  const stored = await ctx.sessionPersistence.open(agent.session.id, 'read')
  let events
  try { events = (await stored.read()).events } finally { await stored.close() }
  const turn = events.findLast(event => event.type === 'turn/end')
  assert.equal(turn?.data.reason.kind, 'completed', JSON.stringify(turn))
  const executed = events.filter(event => event.type === 'tool/call')
  assert.deepEqual(executed.map(event => event.data.name), calls.map(call => call.name))
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, calls.length)
  assert.deepEqual(results.map(event => event.data.message.toolCallId), ['packed-call-1', 'packed-call-2', 'packed-call-3'])
  for (const result of results) assert.equal(result.data.message.isError, false, JSON.stringify(result))
  assert.equal(results[1].data.meta.scroll.kind, 'note')
  assert.equal(results[1].data.meta.scroll.path, notePath)
  assert.equal(results[1].data.meta.scroll.text, noteText)
  assert.equal(JSON.parse(textOf(results[2].data.message)).text, noteText)
  assert.equal(existsSync(join(workspace, notePath)), false, 'notes are persisted session data, not workspace files')
  for (const name of [...runtimePeers, '@deepseek-ai/dsh', '@deepseek-ai/dsh-compaction']) {
    for (const modules of [join(profileDir, 'node_modules'), join(pluginDir, 'node_modules')]) {
      assert.equal(existsSync(join(modules, name)), false, `profile must not install a private ${name}`)
    }
  }
  console.log('DSH_PACKED_RUNTIME_RESULT ' + JSON.stringify({
    completed: true, installAnchor, profileDir, modulePaths, peerPaths, requests,
    calls: executed.map(event => event.data.name),
    results: results.map(event => ({ seq: event.seq, callId: event.data.message.toolCallId, text: textOf(event.data.message) })),
  }))
} finally {
  await ctx?.fiber.dispose()
}
