// @vitest-environment node
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, it } from 'vitest'
import { resolveImporterModulePath } from '../src/bsm/service.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveImporterModulePath', () => {
  // Regression for #1257: the migration child used to spawn URL.pathname,
  // which on win32 is "/C:/Users/..." and resolves as a doubled drive.
  it('converts a win32-style file URL to a plain drive path, never "/C:/..."', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-perf-bsm-'))
    tempDirs.push(dir)
    const modulePath = join(dir, 'better-session-import.mjs')
    writeFileSync(modulePath, 'export {}\n')
    const resolved = resolveImporterModulePath(pathToFileURL(modulePath))
    assert.notEqual(resolved, undefined)
    if (process.platform === 'win32') {
      assert.match(resolved!, /^[A-Za-z]:\\/, 'must be a drive path on win32')
      assert.doesNotMatch(resolved!, /^\/[A-Za-z]:/, 'URL.pathname form must never leak into spawn args')
    }
    assert.equal(resolved, modulePath)
  })

  it('returns undefined for a missing module so the caller falls back in-process', () => {
    const missing = pathToFileURL(join(tmpdir(), 'dsh-perf-absent', 'better-session-import.mjs')).href
    assert.equal(resolveImporterModulePath(missing), undefined)
  })

  it('returns undefined for non-file URLs (test runners may transform modules)', () => {
    assert.equal(resolveImporterModulePath('https://example.invalid/lib/better-session-import.mjs'), undefined)
    assert.equal(resolveImporterModulePath('data:text/plain,hello'), undefined)
  })

  it('falls back when the built artifact is absent next to this module (runMigration call shape)', () => {
    // In the source tree there is no better-session-import.mjs next to service.ts,
    // so the exact URL runMigration builds must resolve to the in-process fallback.
    const importerUrl = new URL('./better-session-import.mjs', import.meta.url)
    assert.equal(resolveImporterModulePath(importerUrl), undefined)
  })
})
