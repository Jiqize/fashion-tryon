import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { projectCard, sortCards, type ProjectCard } from '../src/editor/project-stats.js'
import type { ProjectEntry } from '../src/editor/projects.js'
import { collectionPath } from '../src/simple/collection.js'
import { countShots, runsDir, writeRunRecord, type RunGroup, type RunRecord } from '../src/simple/record.js'
import { makeFixtureRoot, removeFixtureRoot } from './helpers/fixtures.js'
import { writeFixtureRealImage } from './helpers/image-bytes.js'

let root: string

beforeEach(async () => {
  root = await makeFixtureRoot('fashion-tryon-stats-')
})

afterEach(async () => {
  await removeFixtureRoot(root)
})

function entryFor(dir: string): ProjectEntry {
  return { id: 'abc123abc123', root: dir, addedAt: '2026-10-01T00:00:00.000Z' }
}

function record(runId: string, startedAt: string | null, delivered: string[]): RunRecord {
  const runDir = path.join(runsDir(root), runId)
  const groups: RunGroup[] = [{
    sku: 'EX1',
    referenceSource: 'originals',
    swap: 'outfit',
    promptEdited: false,
    references: [],
    prompt: 'p',
    shots: delivered.map((file, index) => ({ model: `EX1/模特/m${String(index)}.jpg`, modelThumb: 'ref/m.jpg', state: 'done', delivered: file })),
  }]
  return {
    schemaVersion: 2,
    runId,
    sourceRoot: root,
    runDir,
    reportPath: path.join(runDir, 'report.html'),
    graphPath: path.join(runDir, 'graph.html'),
    engine: 'fake',
    params: null,
    status: 'completed',
    pid: null,
    startedAt,
    finishedAt: null,
    heartbeatAt: null,
    current: null,
    derivedFrom: null,
    groups,
    counts: countShots(groups),
  }
}

async function listAll(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.map(String).sort()
}

async function twoSkus(): Promise<void> {
  await writeFixtureRealImage(root, 'EX1/服装/g1.jpg', 1)
  await writeFixtureRealImage(root, 'EX1/模特/m1.jpg', 2)
  await writeFixtureRealImage(root, 'EX2/服装/g2.jpg', 3)
}

describe('projectCard', () => {
  it('counts skus and delivered images outside _runs', async () => {
    await twoSkus()
    await writeFixtureRealImage(root, '成图/EX1/a.png', 4)
    await writeFixtureRealImage(root, '成图/EX1/a-v2.png', 5)
    await writeFixtureRealImage(root, '成图/EX2/b.webp', 6)
    await writeFixtureRealImage(root, '成图/_runs/20261016-143200/out/x.png', 7)
    await writeFile(path.join(root, '成图', 'EX1', '.DS_Store'), '')
    const card = await projectCard(entryFor(root))
    expect(card).toMatchObject({ id: 'abc123abc123', name: path.basename(root), root, missing: false, skuCount: 2, outputCount: 3, redoCount: 0 })
  })

  it('uses the newest run for the time and cover, and falls back when the cover is gone', async () => {
    await twoSkus()
    await writeFixtureRealImage(root, '成图/EX1/old.png', 4)
    await writeFixtureRealImage(root, '成图/EX1/new.png', 5)
    for (const item of [
      record('20261016-143200', '2026-10-16T06:32:00.000Z', ['成图/EX1/old.png']),
      record('20261017-090000', '2026-10-17T01:00:00.000Z', ['成图/EX1/new.png']),
    ]) {
      await mkdir(item.runDir, { recursive: true })
      await writeRunRecord(item)
    }
    const before = await listAll(root)
    const card = await projectCard(entryFor(root))
    expect(card.lastRunAt).toBe('2026-10-17T01:00:00.000Z')
    expect(card.cover).toBe('成图/EX1/new.png')
    expect(await listAll(root)).toEqual(before)

    await rm(path.join(root, '成图', 'EX1', 'new.png'))
    expect((await projectCard(entryFor(root))).cover).toBe('成图/EX1/old.png')
  })

  it('takes the time of old-format run records from the runId', async () => {
    await twoSkus()
    await writeFixtureRealImage(root, '成图/EX1/a.png', 4)
    // 旧格式：没有 schemaVersion、startedAt
    const shots = [{ model: 'EX1/模特/m1.jpg', modelThumb: 'ref/m1.jpg', result: 'out/m1.png', delivered: '成图/EX1/a.png' }]
    for (const runId of ['20261014-235435', '20261015-094752']) {
      await mkdir(path.join(runsDir(root), runId), { recursive: true })
      await writeFile(path.join(runsDir(root), runId, 'run.json'), JSON.stringify({ engine: 'codex', groups: [{ sku: 'EX1', references: [], prompt: 'p', shots }] }))
    }
    expect(await projectCard(entryFor(root))).toMatchObject({ lastRunAt: new Date(2026, 9, 15, 9, 47, 52).toISOString(), cover: '成图/EX1/a.png' })

    // 新格式记录更新时以它为准
    const item = record('20261017-090000', '2026-10-17T01:00:00.000Z', ['成图/EX1/a.png'])
    await mkdir(item.runDir, { recursive: true })
    await writeRunRecord(item)
    expect((await projectCard(entryFor(root))).lastRunAt).toBe('2026-10-17T01:00:00.000Z')
  })

  it('falls back to the first garment of the first sku, then to null', async () => {
    await twoSkus()
    expect((await projectCard(entryFor(root))).cover).toBe('EX1/服装/g1.jpg')
    const empty = await makeFixtureRoot('fashion-tryon-stats-empty-')
    try {
      const card = await projectCard(entryFor(empty))
      expect(card).toMatchObject({ missing: false, skuCount: 0, outputCount: 0, lastRunAt: null, cover: null })
    } finally {
      await removeFixtureRoot(empty)
    }
  })

  it('reads the redo count and treats a corrupt collection file as 0', async () => {
    await twoSkus()
    await mkdir(path.dirname(collectionPath(root)), { recursive: true })
    const redo = [1, 2].map((index) => ({ delivered: `成图/EX1/${String(index)}.png`, runId: '20261016-143200', sku: 'EX1', model: 'EX1/模特/m1.jpg' }))
    await writeFile(collectionPath(root), JSON.stringify({ version: 1, order: [], groups: {}, cropFrom: {}, redo }))
    expect((await projectCard(entryFor(root))).redoCount).toBe(2)
    await writeFile(collectionPath(root), '{ broken')
    expect((await projectCard(entryFor(root))).redoCount).toBe(0)
  })

  it('marks a missing folder without throwing', async () => {
    const card = await projectCard(entryFor(path.join(root, 'gone')))
    expect(card).toMatchObject({ missing: true, skuCount: 0, outputCount: 0, lastRunAt: null, redoCount: 0, cover: null })
    await writeFile(path.join(root, 'file.txt'), '')
    expect((await projectCard(entryFor(path.join(root, 'file.txt')))).missing).toBe(true)
  })
})

describe('sortCards', () => {
  it('puts cards with runs first by time, then the rest by added time', () => {
    const card = (id: string, lastRunAt: string | null, addedAt: string): ProjectCard => ({
      id, name: id, root: `/x/${id}`, missing: false, skuCount: 0, outputCount: 0, lastRunAt, redoCount: 0, cover: null, addedAt,
    })
    const cards = [
      card('A', '2026-10-16T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      card('B', null, '2026-10-18T00:00:00.000Z'),
      card('C', '2026-10-17T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      card('D', null, '2026-10-19T00:00:00.000Z'),
    ]
    expect(sortCards(cards).map((item) => item.id)).toEqual(['C', 'A', 'D', 'B'])
  })
})
