import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireRunLock, isProcessAlive, readActiveLock, releaseRunLock } from '../src/simple/lock.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-lock-'))
  roots.push(root)
  return root
}

const lockPath = (root: string): string => path.join(root, '成图', '_runs', '.lock')
const first = { runId: '20261015-090000', pid: 111, startedAt: '2026-10-15T01:00:00.000Z' }
const second = { runId: '20261015-100000', pid: 222, startedAt: '2026-10-15T02:00:00.000Z' }

describe('run lock', () => {
  it('rejects a second run while the holder is alive', async () => {
    const root = await makeRoot()
    await acquireRunLock(root, first, () => true)
    const attempt = acquireRunLock(root, second, () => true)
    await expect(attempt).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    await expect(attempt).rejects.toThrow(first.runId)
    expect(await readActiveLock(root, () => true)).toEqual(first)
  })

  it('takes over a stale lock whose holder is dead', async () => {
    const root = await makeRoot()
    await acquireRunLock(root, first, () => true)
    await acquireRunLock(root, second, () => false)
    expect(await readActiveLock(root, () => true)).toEqual(second)
    expect(await readActiveLock(root, () => false)).toBeNull()
  })

  it('only releases a lock it owns', async () => {
    const root = await makeRoot()
    await acquireRunLock(root, first, () => true)
    await releaseRunLock(root, second.runId)
    await expect(access(lockPath(root))).resolves.toBeUndefined()
    await releaseRunLock(root, first.runId)
    await expect(access(lockPath(root))).rejects.toThrow()
    await releaseRunLock(root, first.runId)
  })

  it('reports the current process as alive and a bogus pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false)
  })
})
