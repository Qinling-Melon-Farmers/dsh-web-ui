/**
 * The CLI gateway: installs and removals executed by spawning the official
 * `dsh plugin --profile <name> add|remove` CLI — the single writer for the
 * profile — with a bounded job table the HTTP layer polls. Every run captures
 * a layer snapshot before and after so the caller can render exactly what the
 * CLI changed (the conflict ledger). Mutations are serialized through one
 * promise chain so snapshots never interleave across jobs. The npm web runtime
 * has no installer service, so this gateway is its write path; on runtimes
 * with official channels the browser half never calls it.
 *
 * Known upstream limitation: the official `dsh plugin` CLI forwards to pnpm
 * with `shell: process.platform === 'win32'` inside the DSH launcher itself.
 * This package spawns the CLI without a shell and whitelists specs at the
 * route, but the final shell hop belongs to upstream DSH and cannot be
 * removed here (documented in the README security model).
 * @module @linxin666/dsh-client-ui-plugin-manager/host
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstalledPluginItem } from '../core/protocol.ts'
import type { ControlChange } from '../core/conflict.ts'
import { diffLayer, overlappingIds, significantChanges, type LayerChange, type LayerSnapshot } from '../core/patch-diff.ts'
import { readProfileManifest, type ProfileFacts } from './profile.ts'
import { claimedIdsOf, parsePatch, bareRowEnabled, bareRowId } from './rows.ts'
import { buildPluginRow, claimedEntryIdsOf } from './state.ts'

/** Hard deadline for one CLI add (git clones can take minutes). */
const ADD_TIMEOUT_MS = 6 * 60_000
/** Hard deadline for one CLI remove. */
const REMOVE_TIMEOUT_MS = 2 * 60_000
/** Bounded capture of the CLI output (the tail survives). */
const MAX_OUTPUT_CHARS = 32_000

/** One CLI-backed operation in flight or settled. */
export interface GatewayJob {
  id: string
  action: 'install' | 'remove'
  spec: string
  phase: 'running' | 'done' | 'error'
  /** The installed row on success (install) or the removed row (remove). */
  plugin?: InstalledPluginItem
  /** Layer changes the CLI applied, normalized for the conflict panel. */
  conflicts?: ControlChange[]
  error?: string
  /** Install-only note: the boot preflight is composition-only (see README B6). */
  preflightNote?: string
}

/** The binary search roots for the dsh CLI. */
export function findDshBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const candidates: string[] = []
  const separator = platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? '').split(separator)) {
    if (dir === '') continue
    if (platform === 'win32') {
      candidates.push(`${dir}\\dsh.cmd`, `${dir}\\dsh.exe`)
    } else {
      candidates.push(`${dir}/dsh`)
    }
  }
  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/dsh', '/usr/local/bin/dsh')
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** Append bounded CLI output (stdout + stderr interleaved is not preserved; tail wins). */
function capture(chunk: Buffer, buffer: { value: string }): void {
  buffer.value = (buffer.value + chunk.toString()).slice(-MAX_OUTPUT_CHARS)
}

/** Best-effort wrapper text read for a dsh.cmd shim (missing file means fallback). */
function readWrapperText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The spawn command for the dsh CLI on this platform. Windows runs the
 * generated dsh.cmd shim by resolving its node binary and bin.js script and
 * spawning them directly: going through cmd.exe splits unquoted paths with
 * spaces (`'D:\Program' is not recognized`).
 *
 * The bin.js path is parsed from the wrapper text when possible (npm, pnpm
 * and yarn global shims all carry it); the npm-layout fallback below covers
 * hand-written wrappers. A shim that resolves through neither path must be
 * reported so the layout can be added here.
 * @param binary - the dsh CLI path found by {@link findDshBinary}.
 * @param platform - process platform (test seam).
 * @param localNodeExists - existence probe (test seam).
 * @param readWrapper - wrapper text seam (test seam).
 * @returns the executable and the argument prefix to run the dsh bin script.
 */
export function dshSpawnCommand(
  binary: string,
  platform: string = process.platform,
  localNodeExists: (path: string) => boolean = existsSync,
  readWrapper: (path: string) => string | null = readWrapperText,
): { command: string; argsPrefix: string[] } {
  if (platform !== 'win32') return { command: binary, argsPrefix: [] }
  const dir = dirname(binary)
  const wrapper = readWrapper(binary)
  const wrapperMatch = wrapper?.match(/"%~dp0\\([^"]*bin\.js)"/)
  const binJs = wrapperMatch != null
    ? join(dir, wrapperMatch[1])
    : join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const localNode = join(dir, 'node.exe')
  return { command: localNodeExists(localNode) ? localNode : process.execPath, argsPrefix: [binJs] }
}

/** Spawn the dsh CLI with piped stdio and no shell parsing (see {@link dshSpawnCommand}). */
export function spawnDsh(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const { command, argsPrefix } = dshSpawnCommand(binary)
  return spawn(command, [...argsPrefix, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Exact entry line the official installer row carries in the boot dump. */
const OFFICIAL_INSTALLER_ROW = /(^|\n)\s*(?:-\s*)?(?:id|name):\s*['"]?ui-settings-plugin-installer\b/m

/**
 * Detect whether the official installer channels exist on this runtime by
 * dumping the boot composition once: the npm-published web never contains an
 * `ui-settings-plugin-installer` entry row, DSHCode and the checkout web do.
 * The match is line-exact (id or name equals the installer entry) so an
 * unrelated plugin whose name merely contains the substring cannot flip the
 * verdict. The browser half reads the result from the `/mode` route so its
 * channel probe never hits the missing official route (which 405s into the
 * console).
 * @param binary - dsh CLI path.
 * @param profileName - boot profile name.
 * @param env - process environment.
 * @param spawnImpl - spawn seam (test seam).
 * @returns true when the dump contains the official installer entry row.
 */
export async function detectOfficialChannels(
  binary: string,
  profileName: string,
  env: NodeJS.ProcessEnv = process.env,
  spawnImpl: typeof spawnDsh = spawnDsh,
): Promise<boolean> {
  const output = { value: '' }
  const child = spawnImpl(binary, ['--profile', profileName, '--dump-config'], env)
  child.stdout?.on('data', (chunk: Buffer) => { output.value = (output.value + chunk.toString()).slice(-MAX_OUTPUT_CHARS) })
  child.stderr?.on('data', (chunk: Buffer) => { output.value = (output.value + chunk.toString()).slice(-MAX_OUTPUT_CHARS) })
  const code = await new Promise<number | null>(resolve => { child.on('close', resolve) })
  if (code !== 0) return false
  return OFFICIAL_INSTALLER_ROW.test(output.value)
}

/**
 * The entry ids a link/file spec would claim, preflight-read from the target
 * directory's bundle patch. Returns undefined when the spec is not a
 * local-directory spec (npm/git specs cannot be preflighted); an empty array
 * means the target has no bundle patch and claims its own package name.
 * @param spec - the install spec recorded by the route.
 * @returns the claimed ids, or undefined when the spec is not preflightable.
 */
export async function preflightClaimedIds(spec: string): Promise<string[] | undefined> {
  const target = spec.match(/^(?:link|file):(.+)$/)?.[1]
  if (target === undefined) return undefined
  try {
    const text = await readFile(join(target, 'cordis.patch.yml'), 'utf8')
    return claimedIdsOf(text)
  } catch {
    return []
  }
}

/** One layer snapshot plus the dependency list of the profile. */
interface CapturedState {
  layer: LayerSnapshot
  dependencies: string[]
}

/** One CLI run result (bounded tail of stdout+stderr). */
interface CliRunResult {
  code: number | null
  output: string
}

/** The gateway: serializes CLI operations through one mutation queue. */
export class CliGateway {
  private readonly jobs = new Map<string, GatewayJob>()
  private counter = 0
  /** Mutation chain: every job's before/after snapshots must not interleave. */
  private queue: Promise<void> = Promise.resolve()

  /** @param facts - resolved profile locations. */
  constructor(
    private readonly facts: ProfileFacts,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly spawnImpl: typeof spawnDsh = spawnDsh,
    private readonly findBinary: typeof findDshBinary = findDshBinary,
  ) {}

  /** Start an install; the caller polls {@link status}. */
  install(spec: string): { jobId: string } {
    const job: GatewayJob = { id: `job-${++this.counter}`, action: 'install', spec, phase: 'running' }
    this.jobs.set(job.id, job)
    this.enqueue(job, ['plugin', '--profile', this.facts.profileName, 'add', spec], ADD_TIMEOUT_MS)
    return { jobId: job.id }
  }

  /** Start a removal; the caller polls {@link status}. */
  remove(id: string): { jobId: string } {
    const job: GatewayJob = { id: `job-${++this.counter}`, action: 'remove', spec: id, phase: 'running' }
    this.jobs.set(job.id, job)
    this.enqueue(job, ['plugin', '--profile', this.facts.profileName, 'remove', id], REMOVE_TIMEOUT_MS)
    return { jobId: job.id }
  }

  /** Read one job's current state (a shallow copy). */
  status(jobId: string): GatewayJob | undefined {
    const job = this.jobs.get(jobId)
    if (job === undefined) return undefined
    return { ...job, conflicts: job.conflicts === undefined ? undefined : [...job.conflicts] }
  }

  /** Chain the run onto the mutation queue so jobs settle one after another. */
  private enqueue(job: GatewayJob, args: string[], timeoutMs: number): void {
    this.queue = this.queue.then(() => this.run(job, args, timeoutMs)).catch(() => {})
  }

  /** Run one CLI operation to settlement, capturing its bounded output. */
  private async cliRun(args: string[], timeoutMs: number): Promise<CliRunResult> {
    const binary = this.findBinary(this.env)
    if (binary === null) return { code: null, output: 'plugin-manager: dsh CLI not found on PATH' }
    const output = { value: '' }
    const child = this.spawnImpl(binary, args, this.env)
    child.stdout?.on('data', (chunk: Buffer) => { capture(chunk, output) })
    child.stderr?.on('data', (chunk: Buffer) => { capture(chunk, output) })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    const code = await new Promise<number | null>(resolve => {
      child.on('close', resolve)
    })
    clearTimeout(timer)
    return { code, output: output.value.trim() }
  }

  /** Capture the layer snapshot and the dependency names (tolerant parse). */
  private async capture(): Promise<CapturedState> {
    const rows = new Map<string, boolean>()
    let patchText = '[]\n'
    try {
      patchText = await readFile(this.facts.patchPath, 'utf8')
    } catch {
      patchText = '[]\n'
    }
    try {
      const { root } = parsePatch(patchText, this.facts.patchPath)
      for (const item of root.items) {
        const id = bareRowId(item)
        if (id !== undefined) rows.set(id, bareRowEnabled(item))
      }
    } catch {
      // A broken patch file must not block an install: the CLI owns the write
      // and the error surfaces through its output.
    }
    let bundles: string[] = []
    let dependencies: string[] = []
    try {
      const manifest = await readProfileManifest(this.facts.packageJsonPath)
      bundles = manifest.bundles
      dependencies = Object.keys(manifest.dependencies)
    } catch {
      bundles = []
      dependencies = []
    }
    return { layer: { rows, bundles }, dependencies }
  }

  /** The plugin row a finished operation produced (installed or removed). */
  private async rowFor(action: 'install' | 'remove', spec: string, before: CapturedState, after: CapturedState): Promise<InstalledPluginItem | undefined> {
    let targetName: string | undefined
    if (action === 'install') {
      targetName = after.dependencies.find(name => !before.dependencies.includes(name))
    } else {
      targetName = before.dependencies.find(name => !after.dependencies.includes(name)) ?? spec
    }
    if (targetName === undefined) return undefined
    const specValue = await readProfileManifest(this.facts.packageJsonPath)
      .then(manifest => manifest.dependencies[targetName as string] ?? spec)
      .catch(() => spec)
    return buildPluginRow(this.facts, targetName, specValue, after.layer.rows)
  }

  /** Run one CLI operation to settlement. */
  private async run(job: GatewayJob, args: string[], timeoutMs: number): Promise<void> {
    const before = await this.capture()

    // Owner-aware preflight (B5, preferred path): for link/file specs the
    // claimed entry ids are readable before the CLI runs, so a conflict is
    // refused outright and the existing owner is never touched.
    if (job.action === 'install') {
      const refusal = await this.preflightEntryOverlap(job.spec, before)
      if (refusal !== undefined) {
        job.phase = 'error'
        job.error = refusal
        return
      }
    }

    const result = await this.cliRun(args, timeoutMs)
    if (result.code !== 0) {
      job.phase = 'error'
      job.error = result.output === ''
        ? `plugin-manager: dsh plugin ${job.action} exited with code ${String(result.code)}`
        : result.output
      return
    }

    const after = await this.capture()
    const conflicts = significantChanges(diffLayer(before.layer, after.layer))

    // B8: a zero exit is not success — verify the dependency really moved.
    if (job.action === 'install') {
      const name = this.newDependency(before, after)
      if (name === undefined) {
        job.phase = 'error'
        job.error = `plugin-manager: install reported success but no dependency was added: ${job.spec}`
        return
      }
      const manifest = await readProfileManifest(this.facts.packageJsonPath).catch(() => undefined)
      if (manifest === undefined || manifest.dependencies[name] === undefined) {
        job.phase = 'error'
        job.error = `plugin-manager: install reported success but ${name} is missing from dependencies`
        return
      }
      // The dependency row can exist while the package never materialized
      // (a link to a missing directory exits 0 with a broken junction): the
      // installed manifest must be readable for the install to count.
      const moduleManifest = join(this.facts.profileDir, 'node_modules', ...name.split('/'), 'package.json')
      if (!existsSync(moduleManifest)) {
        job.phase = 'error'
        job.error = `plugin-manager: install reported success but ${name} did not materialize under node_modules`
        return
      }
      const duplicate = await this.detectDuplicateClaims(before, after)
      if (duplicate !== undefined) {
        // Owner-aware conflict handling (B5, fallback path): roll back the NEW
        // package instead of disabling the shared entry id — a bare disabled
        // row cannot stop the loader's duplicate-id check and would take the
        // existing owner down with it.
        await this.rollbackDependency(duplicate.name)
        conflicts.push({ id: duplicate.name, from: 'uninstalled', to: 'uninstalled' })
        job.phase = 'error'
        job.error = `plugin-manager: install rolled back: ${duplicate.name} claims entry id(s) ${duplicate.ids.join(', ')} already owned by another plugin`
        return
      }
      await this.verifyBoot(job, before, after, conflicts)
    } else {
      if (before.dependencies.includes(job.spec) && after.dependencies.includes(job.spec)) {
        job.phase = 'error'
        job.error = `plugin-manager: remove reported success but ${job.spec} is still installed`
        return
      }
    }

    job.conflicts = conflicts.map(change => ({
      id: change.id,
      name: change.id,
      from: change.from,
      to: change.to,
    }))
    job.plugin = await this.rowFor(job.action, job.spec, before, after)
    if (job.phase !== 'error') job.phase = 'done'
  }

  /** The new dependency of an install, when one exists. */
  private newDependency(before: CapturedState, after: CapturedState): string | undefined {
    return after.dependencies.find(name => !before.dependencies.includes(name))
  }

  /** The claimed entry ids of one installed dependency (its own bundle patch, or its name). */
  private claimedEntriesOf(name: string): Promise<string[]> {
    return claimedEntryIdsOf(this.facts, name)
  }

  /** The entry ids every installed dependency currently claims, excluding one package. */
  private async takenEntryIds(state: CapturedState, exclude?: string): Promise<Set<string>> {
    const taken = new Set<string>(state.layer.rows.keys())
    for (const dep of state.dependencies) {
      if (dep === exclude) continue
      for (const id of await this.claimedEntriesOf(dep)) taken.add(id)
    }
    return taken
  }

  /** Preflight one install spec against the owned entry ids (link/file specs only). */
  private async preflightEntryOverlap(spec: string, before: CapturedState): Promise<string | undefined> {
    const claimed = await preflightClaimedIds(spec)
    if (claimed === undefined || claimed.length === 0) return undefined
    const taken = await this.takenEntryIds(before)
    const overlap = overlappingIds(claimed, taken)
    if (overlap.length === 0) return undefined
    return `plugin-manager: install refused: ${spec} claims entry id(s) ${overlap.join(', ')} already owned by installed plugins`
  }

  /** Whether the new install claims an entry id another plugin already holds. */
  private async detectDuplicateClaims(before: CapturedState, after: CapturedState): Promise<{ name: string; ids: string[] } | undefined> {
    const name = this.newDependency(before, after)
    if (name === undefined) return undefined
    const claimed = await this.claimedEntriesOf(name)
    const taken = await this.takenEntryIds(after, name)
    const overlap = overlappingIds(claimed, taken)
    if (overlap.length === 0) return undefined
    return { name, ids: overlap }
  }

  /** Roll back a freshly added dependency via the official CLI (owner-aware B5). */
  private async rollbackDependency(name: string): Promise<void> {
    await this.cliRun(['plugin', '--profile', this.facts.profileName, 'remove', name], REMOVE_TIMEOUT_MS)
  }

  /**
   * Boot preflight after an install: compose the profile with the CLI's
   * `--dump-config` (resolves every entry without binding the port). This is
   * a composition-only check — it does not import plugin entries, so load-time
   * failures can still surface at the next start (documented limitation, B6).
   * A composition failure that implicates the new plugin disables it; an
   * unrelated failure is reported without touching anything.
   */
  private async verifyBoot(job: GatewayJob, before: CapturedState, after: CapturedState, conflicts: LayerChange[]): Promise<void> {
    const name = this.newDependency(before, after)
    const result = await this.cliRun(['--profile', this.facts.profileName, '--dump-config'], 90_000)
    if (result.code === 0) {
      job.preflightNote = '组合预检通过（--dump-config 仅验证组合层，不验证插件加载期行为），请重启后确认插件可用'
      return
    }
    const tail = result.output
    if (name === undefined) {
      job.phase = 'error'
      job.error = tail === '' ? 'plugin-manager: boot preflight failed' : tail
      return
    }
    const claimed = await this.claimedEntriesOf(name)
    const implicated = tail.includes(name) || claimed.some(id => tail.includes(id))
    if (implicated) {
      await this.rollbackDependency(name)
      conflicts.push({ id: claimed[0] ?? name, from: 'uninstalled', to: 'uninstalled' })
      job.phase = 'error'
      job.error = tail === ''
        ? `plugin-manager: 启动预检失败，已回滚 ${name}`
        : `plugin-manager: 启动预检失败，已回滚 ${name}：
${tail}`
    } else {
      job.phase = 'error'
      job.error = tail === ''
        ? 'plugin-manager: 启动预检失败（与本次安装无关）'
        : `plugin-manager: 启动预检失败（与本次安装无关）：
${tail}`
    }
  }
}
