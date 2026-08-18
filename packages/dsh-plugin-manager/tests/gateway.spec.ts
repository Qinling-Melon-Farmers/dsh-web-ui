import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectOfficialChannels, dshSpawnCommand, findDshBinary, preflightClaimedIds } from '../src/host/gateway.ts'
import { sourceKindOf } from '../src/host/state.ts'

describe('findDshBinary', () => {
  const exists = (present: string[]) => (path: string) => present.includes(path)

  it('finds a dsh on a POSIX PATH', () => {
    expect(findDshBinary({ PATH: '/usr/bin' }, 'darwin', exists(['/usr/bin/dsh']))).toBe('/usr/bin/dsh')
  })

  it('finds a dsh.cmd on Windows', () => {
    expect(findDshBinary({ PATH: 'C:\\tools' }, 'win32', exists(['C:\\tools\\dsh.cmd']))).toBe('C:\\tools\\dsh.cmd')
  })

  it('falls back to the darwin homebrew location', () => {
    expect(findDshBinary({ PATH: '/nothing' }, 'darwin', exists(['/opt/homebrew/bin/dsh']))).toBe('/opt/homebrew/bin/dsh')
  })

  it('returns null when nothing matches', () => {
    expect(findDshBinary({ PATH: '/definitely/absent' }, 'linux', exists([]))).toBeNull()
  })
})

describe('sourceKindOf', () => {
  it('classifies registry specs as npm and git/link specs as git', () => {
    expect(sourceKindOf('@scope/pkg')).toBe('npm')
    expect(sourceKindOf('pkg@1.0.0')).toBe('npm')
    expect(sourceKindOf('link:/x/packages/y')).toBe('git')
    expect(sourceKindOf('git+https://github.com/a/b')).toBe('git')
    expect(sourceKindOf('github:a/b')).toBe('git')
    expect(sourceKindOf('https://github.com/a/b')).toBe('git')
  })
})

describe('dshSpawnCommand', () => {
  it('keeps the binary as-is off Windows', () => {
    expect(dshSpawnCommand('/usr/local/bin/dsh', 'darwin')).toEqual({ command: '/usr/local/bin/dsh', argsPrefix: [] })
  })

  it('resolves the wrapper into node + bin.js on Windows, preferring a local node', () => {
    const binary = 'C:\\Program Files\\nodejs\\dsh.cmd'
    expect(dshSpawnCommand(binary, 'win32', () => true)).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      argsPrefix: ['C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'],
    })
  })

  it('keeps the full bin.js path as one argument (spaces survive)', () => {
    const { command, argsPrefix } = dshSpawnCommand('C:\\Program Files\\nodejs\\dsh.cmd', 'win32', () => false)
    expect(argsPrefix).toHaveLength(1)
    expect(argsPrefix[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
    expect(command).toBe(process.execPath)
  })

  it('parses the bin.js path out of a pnpm/yarn-style wrapper when present', () => {
    const binary = 'C:\\pnpm-store\\global\\dsh.cmd'
    const wrapper = 'SETLOCAL\nendLocal & "%~dp0\\node.exe" "%~dp0\\..\\store\\@deepseek-ai\\dsh\\lib\\bin.js" %*'
    expect(dshSpawnCommand(binary, 'win32', () => false, () => wrapper)).toEqual({
      command: process.execPath,
      argsPrefix: ['C:\\pnpm-store\\store\\@deepseek-ai\\dsh\\lib\\bin.js'],
    })
  })

  it('falls back to the npm layout when the wrapper carries no bin.js path', () => {
    const binary = 'C:\\tools\\dsh.cmd'
    const wrapper = 'ECHO off'
    expect(dshSpawnCommand(binary, 'win32', () => false, () => wrapper)).toEqual({
      command: process.execPath,
      argsPrefix: ['C:\\tools\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'],
    })
  })
})

describe('detectOfficialChannels', () => {
  const fakeSpawn = (output: string, code = 0) => () => ({
    stdout: { on: (event: string, handler: (chunk: Buffer) => void) => { if (event === 'data') handler(Buffer.from(output)) } },
    stderr: { on: () => {} },
    on: (event: string, handler: (chunk?: number | null) => void) => { if (event === 'close') setTimeout(() => handler(code), 0) },
  })

  it('reports official channels when the dump has the installer entry row', async () => {
    const probe = fakeSpawn('entries:\n  - id: ui-settings-plugin-installer\n    name: whatever')
    await expect(detectOfficialChannels('/usr/bin/dsh', 'web', {}, probe as never)).resolves.toBe(true)
  })

  it('reports no official channels on the npm web dump', async () => {
    const probe = fakeSpawn('entries: dsh-base, dsh-web-app')
    await expect(detectOfficialChannels('/usr/bin/dsh', 'web', {}, probe as never)).resolves.toBe(false)
  })

  it('does not match a mere substring of an unrelated entry', async () => {
    const probe = fakeSpawn('entries:\n  - id: my-plugin-installer-helper\n    config: mentions plugin-installer in prose')
    await expect(detectOfficialChannels('/usr/bin/dsh', 'web', {}, probe as never)).resolves.toBe(false)
  })

  it('treats a failed dump as no official channels', async () => {
    const probe = fakeSpawn('boot failed', 1)
    await expect(detectOfficialChannels('/usr/bin/dsh', 'web', {}, probe as never)).resolves.toBe(false)
  })
})

describe('preflightClaimedIds', () => {
  const dirs: string[] = []

  it('reads the bundle patch ids of a link target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-manager-preflight-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'pkg', 'cordis.patch.yml'), '- insert:\n    - id: memoir\n      name: x\n')
    await expect(preflightClaimedIds('link:' + join(dir, 'pkg'))).resolves.toEqual(['memoir'])
  })

  it('returns an empty array when the target has no bundle patch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-manager-preflight-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'pkg', 'package.json'), '{}')
    await expect(preflightClaimedIds('file:' + join(dir, 'pkg'))).resolves.toEqual([])
  })

  it('returns undefined for npm and git specs', async () => {
    await expect(preflightClaimedIds('dsh-memoir')).resolves.toBeUndefined()
    await expect(preflightClaimedIds('github:owner/repo')).resolves.toBeUndefined()
  })

  it('cleans up temp dirs', () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
})
