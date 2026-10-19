import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  collectionPath,
  groupPrefs,
  KEEP_FRAME_SENTENCE,
  PAIRING_LABELS,
  readCollection,
  updateCollection,
} from '../src/simple/collection.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-collection-'))
  roots.push(root)
  return root
}

describe('collection state', () => {
  it('returns the default state without creating any file', async () => {
    const root = await makeRoot()
    expect(await readCollection(root)).toEqual({ version: 1, order: [], groups: {}, itemOrder: {}, cropFrom: {}, redo: [] })
    expect(await readdir(root)).toEqual([])
  })

  it('persists updates at 成图/_runs/collection.json', async () => {
    const root = await makeRoot()
    expect(collectionPath(root)).toBe(path.join(root, '成图', '_runs', 'collection.json'))
    await updateCollection(root, (state) => {
      state.groups.EX1 = { ...groupPrefs(state, 'EX1'), pairing: 'fixedModel' }
    })
    expect((await readCollection(root)).groups.EX1?.pairing).toBe('fixedModel')
    expect(await readdir(path.join(root, '成图', '_runs'))).toEqual(['collection.json'])
  })

  it('serializes concurrent updates', async () => {
    const root = await makeRoot()
    await Promise.all([
      updateCollection(root, (state) => {
        state.redo.push({ delivered: '成图/EX1/m1.png', runId: 'r1', sku: 'EX1', model: '模特/EX1/m1.jpg' })
      }),
      updateCollection(root, (state) => {
        state.redo.push({ delivered: '成图/EX1/m2.png', runId: 'r1', sku: 'EX1', model: '模特/EX1/m2.jpg', note: '腿' })
      }),
    ])
    expect((await readCollection(root)).redo.map((item) => item.delivered).sort()).toEqual(['成图/EX1/m1.png', '成图/EX1/m2.png'])
  })

  it('rejects a corrupt file and leaves it untouched', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, '成图', '_runs'), { recursive: true })
    await writeFile(collectionPath(root), '{not json', 'utf8')
    await expect(readCollection(root)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: '合集设置文件损坏：成图/_runs/collection.json',
    })
    await expect(updateCollection(root, () => undefined)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await readFile(collectionPath(root), 'utf8')).toBe('{not json')

    await writeFile(collectionPath(root), JSON.stringify({ version: 2 }), 'utf8')
    await expect(readCollection(root)).rejects.toMatchObject({ message: '合集设置文件损坏：成图/_runs/collection.json' })
  })

  it('defaults group prefs and exposes fixed labels and sentence', async () => {
    const root = await makeRoot()
    expect(groupPrefs(await readCollection(root), 'NO')).toEqual({ pairing: 'fixedGarment', keepFrame: false, halfModels: [] })
    expect(PAIRING_LABELS).toEqual({ fixedGarment: '固定服装', fixedModel: '固定模特', oneToOne: '一对一' })
    expect(KEEP_FRAME_SENTENCE).toBe('保持图1的取景范围，被截掉、没拍到的身体部位不要补画。')
  })
})
