import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import {
  batchCounts,
  batchStateSchema,
  groupStatus,
  type BatchState,
  type Group,
  type Task,
} from '../../src/studio/model.js'
import { batchDirFor, openBatch, type BatchStore } from '../../src/studio/store.js'

const roots: string[] = []
const stores: BatchStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeSourceRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'studio-store-'))
  roots.push(parent)
  const sourceRoot = path.join(parent, '本次素材')
  await mkdir(sourceRoot)
  return sourceRoot
}

async function open(sourceRoot: string): Promise<BatchStore> {
  const store = await openBatch(sourceRoot)
  stores.push(store)
  return store
}

describe('batchDirFor', () => {
  it('places the batch directory beside the source root', () => {
    expect(batchDirFor('/a/本次素材')).toBe('/a/本次素材-tryon-studio')
  })
})

describe('openBatch', () => {
  it('creates studio.json with default settings', async () => {
    const sourceRoot = await makeSourceRoot()
    const store = await open(sourceRoot)
    expect(store.dir).toBe(batchDirFor(sourceRoot))
    const saved = JSON.parse(await readFile(path.join(store.dir, 'studio.json'), 'utf8'))
    expect(batchStateSchema.parse(saved)).toMatchObject({
      schemaVersion: 1,
      settings: { mode: 'fixedClothing', scope: 'full', candidates: 1, concurrency: 5, size: '3:4' },
      groups: [],
      assets: [],
      tasks: [],
      generationCallsUsed: 0,
    })
    expect(store.state().settings.imageModel).toBe(process.env.IMAGE_MODEL ?? '')
    // 状态里不写绝对路径
    expect(JSON.stringify(saved)).not.toContain(path.dirname(sourceRoot))
    expect(path.resolve(store.dir, store.state().sourceRoot)).toBe(sourceRoot)
    expect((await stat(path.join(store.dir, 'studio.json'))).mode & 0o777).toBe(0o600)
  })

  it('reopens an existing batch with its saved state', async () => {
    const sourceRoot = await makeSourceRoot()
    const first = await openBatch(sourceRoot)
    await first.update((draft) => {
      draft.generationCallsUsed = 3
    })
    await first.close()
    const second = await open(sourceRoot)
    expect(second.state().generationCallsUsed).toBe(3)
  })

  it('rejects a second open of the same batch', async () => {
    const sourceRoot = await makeSourceRoot()
    await open(sourceRoot)
    await expect(openBatch(sourceRoot)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining(String(process.pid)),
    })
  })

  it('reclaims a lock held by a dead process', async () => {
    const sourceRoot = await makeSourceRoot()
    const dir = batchDirFor(sourceRoot)
    await mkdir(dir)
    await writeFile(
      path.join(dir, '.run.lock'),
      `${JSON.stringify({ pid: 999_999, startedAt: '2026-09-25T00:00:00.000Z' })}\n`,
    )
    const store = await open(sourceRoot)
    expect(JSON.parse(await readFile(path.join(dir, '.run.lock'), 'utf8'))).toMatchObject({
      pid: process.pid,
    })
    expect(store.state().schemaVersion).toBe(1)
  })

  it('removes leftover version temp files when the lock is taken', async () => {
    const sourceRoot = await makeSourceRoot()
    const dir = batchDirFor(sourceRoot)
    await mkdir(path.join(dir, 'images'), { recursive: true })
    const leftover = path.join(dir, 'images', 'task-v1.jpg.tmp-1-abandoned')
    await writeFile(leftover, new Uint8Array([1, 2, 3]))

    await open(sourceRoot)

    await expect(stat(leftover)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an invalid studio.json', async () => {
    const sourceRoot = await makeSourceRoot()
    const dir = batchDirFor(sourceRoot)
    await mkdir(dir)
    await writeFile(path.join(dir, 'studio.json'), JSON.stringify({ schemaVersion: 1, groups: 'x' }))
    await expect(openBatch(sourceRoot)).rejects.toMatchObject({ code: 'INTEGRITY_ERROR' })
  })
})

describe('BatchStore.update', () => {
  it('serializes concurrent updates and keeps the file parseable', async () => {
    const sourceRoot = await makeSourceRoot()
    const store = await open(sourceRoot)
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update((draft) => {
          draft.generationCallsUsed += 1
        }),
      ),
    )
    expect(store.state().generationCallsUsed).toBe(20)
    const saved = batchStateSchema.parse(
      JSON.parse(await readFile(path.join(store.dir, 'studio.json'), 'utf8')),
    )
    expect(saved.generationCallsUsed).toBe(20)
  })
})

describe('BatchStore.writeVersionImage', () => {
  it('writes a numbered version file and refuses to overwrite it', async () => {
    const sourceRoot = await makeSourceRoot()
    const store = await open(sourceRoot)
    const bytes = new Uint8Array(await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer())
    const written = await store.writeVersionImage('task_a', bytes, 'image/png')
    expect(written.relativePath).toMatch(/^images\/task_a\/01-[a-f0-9]{8}\.png$/)
    expect(written.relativePath).toContain(written.sha256.slice(0, 8))
    expect(await readFile(store.resolve(written.relativePath))).toEqual(Buffer.from(bytes))

    // 状态尚未追加版本 → 序号仍是 01，同名文件不覆盖
    await expect(store.writeVersionImage('task_a', bytes, 'image/png')).rejects.toMatchObject({
      code: 'INTEGRITY_ERROR',
    })
    expect(await readFile(store.resolve(written.relativePath))).toEqual(Buffer.from(bytes))
  })
})

describe('BatchStore.thumbnail', () => {
  it('creates a 480px JPEG thumbnail and reuses the cache', async () => {
    const sourceRoot = await makeSourceRoot()
    const store = await open(sourceRoot)
    const source = await sharp({
      create: { width: 600, height: 900, channels: 3, background: { r: 120, g: 110, b: 100 } },
    }).png().toBuffer()
    const written = await store.writeVersionImage('task_b', new Uint8Array(source), 'image/png')

    const thumb = await store.thumbnail(written.relativePath, 480)
    expect(thumb.startsWith('thumbs/')).toBe(true)
    const meta = await sharp(store.resolve(thumb)).metadata()
    expect(meta.format).toBe('jpeg')
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(480)

    const before = (await stat(store.resolve(thumb))).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await store.thumbnail(written.relativePath, 480)).toBe(thumb)
    expect((await stat(store.resolve(thumb))).mtimeMs).toBe(before)
  })

  it('regenerates the thumbnail when the source content changes', async () => {
    const sourceRoot = await makeSourceRoot()
    const store = await open(sourceRoot)
    const sourcePath = path.join(sourceRoot, 'a.png')
    const colored = (r: number) => sharp({
      create: { width: 500, height: 500, channels: 3, background: { r, g: 0, b: 0 } },
    }).png().toBuffer()
    await writeFile(sourcePath, await colored(10))
    const relative = path.relative(store.dir, sourcePath)
    const first = await store.thumbnail(relative, 480)
    await writeFile(sourcePath, await colored(200))
    const second = await store.thumbnail(relative, 480)
    expect(second).not.toBe(first)
  })
})

function makeState(groups: Group[], tasks: Task[]): BatchState {
  return {
    schemaVersion: 1,
    batchId: 'batch-1',
    sourceRoot: '../本次素材',
    createdAt: '2026-09-25T00:00:00.000Z',
    settings: {
      mode: 'fixedClothing',
      scope: 'full',
      candidates: 1,
      concurrency: 5,
      size: '3:4',
      imageModel: 'm',
    },
    groups,
    assets: [],
    tasks,
    generationCallsUsed: 4,
  }
}

function group(id: string, extra: Partial<Group> = {}): Group {
  return { id, sku: id, name: '', dir: id, order: 0, started: true, ...extra }
}

function task(id: string, groupId: string, status: Task['status'], extra: Partial<Task> = {}): Task {
  return {
    id,
    groupId,
    garmentAssetId: 'g',
    modelAssetId: 'm',
    status,
    versions: [],
    excluded: false,
    pending: [],
    ...extra,
  }
}

describe('groupStatus and batchCounts', () => {
  it('derives each of the seven group states consistently', () => {
    const state = makeState(
      [
        group('inc', { incompleteReason: '缺少模特图', started: false }),
        group('del', { delivered: { at: '2026-09-25T01:00:00.000Z', files: ['a.png'] } }),
        group('idle', { started: false }),
        group('que'),
        group('gen'),
        group('gen2'),
        group('fail'),
        group('rev'),
      ],
      [
        task('d1', 'del', 'done'),
        task('i1', 'idle', 'queued'),
        task('q1', 'que', 'queued'),
        // 开始后排队的任务带着尚未派发的首轮作业，整套仍是 queued
        task('q2', 'que', 'queued', { pending: [{ jobId: 'j0', kind: 'first' }] }),
        task('g1', 'gen', 'running'),
        task('g2', 'gen', 'done'),
        task('g3', 'gen2', 'done', { pending: [{ jobId: 'j1', kind: 'regen' }] }),
        task('f1', 'fail', 'failed', { error: { code: 'PROVIDER_ERROR', message: 'x' } }),
        task('f2', 'fail', 'done'),
        task('r1', 'rev', 'done'),
        task('r2', 'rev', 'done'),
      ],
    )
    expect(batchStateSchema.parse(state)).toEqual(state)
    expect(groupStatus(state, 'inc')).toBe('incomplete')
    expect(groupStatus(state, 'del')).toBe('delivered')
    expect(groupStatus(state, 'idle')).toBe('idle')
    expect(groupStatus(state, 'que')).toBe('queued')
    expect(groupStatus(state, 'gen')).toBe('generating')
    expect(groupStatus(state, 'gen2')).toBe('generating')
    expect(groupStatus(state, 'fail')).toBe('failed')
    expect(groupStatus(state, 'rev')).toBe('review')

    expect(batchCounts(state)).toEqual({
      delivered: 1,
      review: 1,
      generating: 2,
      queued: 1,
      incomplete: 1,
      failed: 1,
      tasks: 11,
      generationCalls: 4,
    })
  })
})
