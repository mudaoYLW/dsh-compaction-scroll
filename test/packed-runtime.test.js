import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repository = fileURLToPath(new URL('../', import.meta.url))
const enabled = process.env.DSH_PACKED_RUNTIME === '1' || Boolean(process.env.DSH_PACKED_TARBALL)
const resultPrefix = 'DSH_PACKED_RUNTIME_RESULT '

async function command(file, args, options) {
  try {
    return await exec(file, args, { maxBuffer: 16 * 1024 * 1024, ...options })
  } catch (error) {
    throw new Error(`${file} ${args.join(' ')} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error })
  }
}

// Opt in because a fresh host needs npm registry/cache access and native PTY dependencies.
// DSH_PACKED_HOST can reuse an installed host, never the repository's plugin module.
test('packed profile plugin runs native bash and durable notes against a separate DSH host', {
  skip: !enabled ? 'set DSH_PACKED_RUNTIME=1 or DSH_PACKED_TARBALL' : process.platform === 'win32' && 'requires POSIX bash',
  timeout: 900000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'scroll-packed-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'dsh-home')
  const profileDir = join(home, 'profiles', 'packed-notes')
  const workspace = join(root, 'workspace')
  const userHome = join(root, 'user-home')
  await Promise.all([profileDir, workspace, userHome].map(path => mkdir(path, { recursive: true })))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const runtimeVersion = manifest.peerDependencies['@deepseek-ai/dsh']
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmOptions = { env, timeout: 600000 }

  let tarball = process.env.DSH_PACKED_TARBALL && await realpath(resolve(process.env.DSH_PACKED_TARBALL))
  if (!tarball) {
    const packed = await command(npm, ['pack', '--json', '--pack-destination', root], { ...npmOptions, cwd: repository })
    const [archive] = JSON.parse(packed.stdout)
    tarball = join(root, archive.filename)
  }

  let hostRoot = process.env.DSH_PACKED_HOST && await realpath(resolve(process.env.DSH_PACKED_HOST))
  if (!hostRoot) {
    hostRoot = join(root, 'host')
    await mkdir(hostRoot)
    await writeFile(join(hostRoot, 'package.json'), JSON.stringify({
      name: 'scroll-packed-runtime-host', private: true, type: 'module',
      dependencies: { '@deepseek-ai/dsh': runtimeVersion },
    }))
    // Native host dependencies (notably node-pty's spawn helper) need their install hooks.
    await command(npm, ['install', '--no-audit', '--no-fund'], { ...npmOptions, cwd: hostRoot })
  }
  const hostRequire = createRequire(join(hostRoot, 'package.json'))
  const installAnchor = await realpath(hostRequire.resolve('@deepseek-ai/dsh/package.json'))
  const installedHost = JSON.parse(await readFile(installAnchor, 'utf8'))
  assert.equal(installedHost.version, runtimeVersion)
  assert.notEqual(dirname(installAnchor), profileDir)

  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'scroll-packed-runtime-profile', private: true, type: 'module',
    dependencies: { [manifest.name]: `file:${tarball}` },
    dsh: { profile: { bundles: [manifest.name] } },
  }))
  // DSH profiles disable auto-installed peers: only regular dependencies belong here.
  // Preserve npm_config_offline and registry/cache settings supplied by the caller.
  await command(npm, ['install', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], {
    ...npmOptions, cwd: profileDir,
  })

  // Copy the runner OUT of the package/repository: its module ancestry cannot self-resolve
  // dsh-compaction-scroll back to source or accidentally deduplicate the profile with the host.
  const runner = join(root, 'packed-runtime-runner.mjs')
  await copyFile(new URL('./support/packed-runtime-runner.js', import.meta.url), runner)
  const result = await command(process.execPath, [runner, installAnchor, profileDir, workspace], {
    cwd: root,
    timeout: 120000,
    env: { ...env, HOME: userHome, USERPROFILE: userHome, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', BASH_ENV: '', ENV: '' },
  })
  const line = result.stdout.split('\n').find(line => line.startsWith(resultPrefix))
  assert.ok(line, `runner did not report completion\n${result.stdout}\n${result.stderr}`)
  const report = JSON.parse(line.slice(resultPrefix.length))
  assert.equal(report.completed, true)
  assert.equal(report.requests, 4)
  assert.deepEqual(report.calls, ['bash', 'scroll_notes_write', 'scroll_notes_read'])
  t.diagnostic(JSON.stringify(report))
})
