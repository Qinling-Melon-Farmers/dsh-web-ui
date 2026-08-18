import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliGateway } from '../src/host/gateway.ts'
import type { ProfileFacts } from '../src/host/profile.ts'

/** One temp profile directory (facts + the profile files live under it). */
function makeProfile(deps: Record<string, string> = {}, bundles: string[] = []): { facts: ProfileFacts; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-manager-gateway-'))
  const profileDir = join(dir, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: deps,
    dsh: { profile: { bundles } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# layer\n[]\n')
  const facts: ProfileFacts = {
    profileName: 'web',
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    packageJsonPath: join(profileDir, 'package.json'),
  }
  return { facts, dir }
}

/** Install one dependency-shaped package under the temp profile. */
function installPackage(dir: string, name: string, claimedIds: string[]): void {
  const profileDir = join(dir, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.4.3' }))
  if (claimedIds.length > 0) {
    const rows = claimedIds.map(id => `    - id: ${id}\n      name: ${name}\n`).join('')
    writeFileSync(join(profileDir, 'node_modules', name, 'cordis.patch.yml'), `- insert:\n${rows}`)
  }
}

/** A fake spawn seam recording its calls; each entry can prescribe output/code/delay. */
function fakeSpawn(script: Array<{ args: string[]; code: number; output?: string; delayMs?: number }>) {
  const calls: Array<{ args: string[]; at: number }> = []
  const impl = (_binary: string, args: string[], _env: NodeJS.ProcessEnv) => {
    calls.push({ args, at: Date.now() })
    const step = script.shift() ?? { args, code: 0 }
    const output = step.output ?? ''
    return {
      stdout: { on: (event: string, handler: (chunk: Buffer) => void) => { if (event === 'data' && output !== '') handler(Buffer.from(output)) } },
      stderr: { on: () => {} },
      on: (event: string, handler: (code: number | null) => void) => {
        if (event === 'close') setTimeout(() => handler(step.code), step.delayMs ?? 0)
      },
      kill: () => {},
    }
  }
  return { impl: impl as never, calls }
}

/** Wait for one job to settle. */
async function waitJob(gateway: CliGateway, jobId: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const job = gateway.status(jobId)!
    if (job.phase !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job never settled')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('gateway owner-aware conflict handling (B5)', () => {
  it('refuses a link install whose bundle patch claims an owned entry id, without calling the CLI', async () => {
    const { facts, dir } = makeProfile({ 'dsh-memoir': 'link:/memoir' }, ['dsh-memoir'])
    tempDirs.push(dir)
    installPackage(dir, 'dsh-memoir', ['memoir'])
    // collision target directory with a bundle patch claiming memoir
    const fixture = join(dir, 'fixtures', 'collision')
    mkdirSync(fixture, { recursive: true })
    writeFileSync(join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: memoir\n      name: collision\n')
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'collision', version: '0.0.1' }))
    const { impl, calls } = fakeSpawn([])
    const gateway = new CliGateway(facts, { PATH: '/fake' }, impl, () => '/fake/dsh.cmd')
    const { jobId } = gateway.install(`link:${fixture}`)
    const job = await waitJob(gateway, jobId)
    expect(job.phase).toBe('error')
    expect(job.error).toContain('install refused')
    expect(calls).toHaveLength(0)
    // profile untouched
    expect(readFileSync(facts.packageJsonPath, 'utf8')).toContain('dsh-memoir')
  })

  it('rolls back the new package when an npm-style install claims an owned id (fallback path)', async () => {
    const { facts, dir } = makeProfile({ 'dsh-memoir': 'link:/memoir' }, ['dsh-memoir'])
    tempDirs.push(dir)
    installPackage(dir, 'dsh-memoir', ['memoir'])
    // the fake CLI adds the collision dependency, then the rollback removes it
    const { impl, calls } = fakeSpawn([
      { args: ['plugin', '--profile', 'web', 'add', 'collision'], code: 0, output: '' },
      { args: ['plugin', '--profile', 'web', 'remove', 'collision'], code: 0, output: '' },
    ])
    const gateway = new CliGateway(facts, { PATH: '/fake' }, impl, () => '/fake/dsh.cmd')
    const { jobId } = gateway.install('collision')
    // simulate the CLI add writing the dependency after the first spawn
    const profileDir = join(dir, 'profiles', 'web')
    const poll = setInterval(() => {
      if (calls.length >= 1) {
        const manifest = JSON.parse(readFileSync(facts.packageJsonPath, 'utf8')) as { dependencies: Record<string, string> }
        manifest.dependencies['collision'] = '0.0.1'
        writeFileSync(facts.packageJsonPath, JSON.stringify(manifest, null, 2))
        installPackage(dir, 'collision', ['memoir'])
        clearInterval(poll)
      }
    }, 5)
    const job = await waitJob(gateway, jobId)
    clearInterval(poll)
    expect(job.phase).toBe('error')
    expect(job.error).toContain('rolled back')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    void profileDir
  })
})

describe('gateway install verification (B8)', () => {
  it('reports an error when the CLI exits 0 but no dependency was added', async () => {
    const { facts, dir } = makeProfile()
    tempDirs.push(dir)
    const { impl } = fakeSpawn([
      { args: ['plugin', '--profile', 'web', 'add', 'ghost'], code: 0, output: 'done' },
    ])
    const gateway = new CliGateway(facts, { PATH: '/fake' }, impl, () => '/fake/dsh.cmd')
    const { jobId } = gateway.install('ghost')
    const job = await waitJob(gateway, jobId)
    expect(job.phase).toBe('error')
    expect(job.error).toContain('no dependency was added')
  })
})

describe('gateway mutation serialization (B7)', () => {
  it('settles concurrent installs one after another with correct ownership', async () => {
    const { facts, dir } = makeProfile()
    tempDirs.push(dir)
    const profileDir = join(dir, 'profiles', 'web')
    // First CLI call adds dep-a (slow), second adds dep-b; both succeed.
    const { impl, calls } = fakeSpawn([
      { args: ['plugin', '--profile', 'web', 'add', 'dep-a'], code: 0, output: '', delayMs: 60 },
      { args: ['plugin', '--profile', 'web', 'add', 'dep-b'], code: 0, output: '', delayMs: 10 },
    ])
    const gateway = new CliGateway(facts, { PATH: '/fake' }, impl, () => '/fake/dsh.cmd')
    // Add deps as the fake CLI runs: dep-a after the first CLI add starts,
    // dep-b after the second (verifyBoot also calls the CLI, so count adds).
    let addsSeen = 0
    const poll = setInterval(() => {
      const addCount = calls.filter(call => call.args[0] === 'plugin' && call.args[3] === 'add').length
      if (addCount > addsSeen) {
        addsSeen = addCount
        const manifest = JSON.parse(readFileSync(facts.packageJsonPath, 'utf8')) as { dependencies: Record<string, string> }
        if (addCount === 1) { manifest.dependencies['dep-a'] = '1.0.0'; installPackage(dir, 'dep-a', []) }
        if (addCount === 2) { manifest.dependencies['dep-b'] = '1.0.0'; installPackage(dir, 'dep-b', []) }
        writeFileSync(facts.packageJsonPath, JSON.stringify(manifest, null, 2))
      }
      if (addsSeen >= 2) clearInterval(poll)
    }, 5)
    const a = gateway.install('dep-a')
    const b = gateway.install('dep-b')
    const jobA = await waitJob(gateway, a.jobId)
    const jobB = await waitJob(gateway, b.jobId)
    clearInterval(poll)
    expect(jobA.phase).toBe('done')
    expect(jobB.phase).toBe('done')
    expect(jobA.plugin?.id).toBe('dep-a')
    expect(jobB.plugin?.id).toBe('dep-b')
    // The second job must not observe the first one's before snapshot: dep-a
    // is present when dep-b's before snapshot is captured (serialization).
    expect(calls[0]!.args).toEqual(['plugin', '--profile', 'web', 'add', 'dep-a'])
    expect(calls[2]!.args).toEqual(['plugin', '--profile', 'web', 'add', 'dep-b'])
    void profileDir
  })
})
