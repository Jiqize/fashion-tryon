import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { orderFiles, readCollection, updateCollection } from '../src/simple/collection.js'
import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import { acquireRunLock, releaseRunLock } from '../src/simple/lock.js'
import { restoreItem, trashItem } from '../src/simple/trash.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-trash-'))
  roots.push(root)
  for (const [index, file] of ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg'].entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身' }] }))
  return root
}

const present = (root: string, file: string): Promise<boolean> => readFile(path.join(root, file)).then(() => true, () => false)

describe('garment trash', () => {
  it('moves a garment with its crops out and back without touching other files', async () => {
    const root = await makeRoot()
    const crop = Object.keys((await readCollection(root)).cropFrom)[0]!
    const result = await trashItem(root, 'EX1', '服装/EX1/g1.jpg')
    expect(result.files).toEqual(['服装/EX1/g1.jpg', crop])
    expect(await present(root, '服装/EX1/g1.jpg')).toBe(false)
    expect(await present(root, crop)).toBe(false)
    expect(await present(root, '服装/EX1/g2.jpg')).toBe(true)
    await restoreItem(root, 'EX1', result.id)
    expect(await present(root, '服装/EX1/g1.jpg')).toBe(true)
    expect(await present(root, crop)).toBe(true)
    expect(await readdir(path.join(root, '成图', '_runs', '已删除', 'EX1'))).toEqual([])
  })

  it('rejects files outside the sku, unknown ids and restoring over an existing file', async () => {
    const root = await makeRoot()
    const crop = Object.keys((await readCollection(root)).cropFrom)[0]!
    await expect(trashItem(root, 'EX1', crop)).rejects.toThrow('EX1 没有这张图')
    await expect(trashItem(root, 'EX1', '成图/EX2/m1.png')).rejects.toThrow('EX1 没有这张图')
    await expect(trashItem(root, 'EX1', '成图/EX1/../../服装/EX1/g1.jpg')).rejects.toThrow('EX1 没有这张图')
    await expect(trashItem(root, 'EX1', '../服装/EX1/g1.jpg')).rejects.toThrow('EX1 没有这张图')
    await expect(restoreItem(root, 'EX1', 'not-an-id')).rejects.toThrow('找不到要撤销的删除')
    const result = await trashItem(root, 'EX1', '服装/EX1/g2.jpg')
    await writeFile(path.join(root, '服装/EX1/g2.jpg'), await fixtureImageBytes(9))
    await expect(restoreItem(root, 'EX1', result.id)).rejects.toThrow('原位置已有同名文件：服装/EX1/g2.jpg')
  })

  it('moves a model and an output out and back, dropping the output from redo', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, '成图/EX1'), { recursive: true })
    await writeFile(path.join(root, '成图/EX1/m1.png'), await fixtureImageBytes(5, 'png'))
    await updateCollection(root, (state) => { state.redo = [{ delivered: '成图/EX1/m1.png', runId: '20261016-000000', sku: 'EX1', model: '模特/EX1/m1.jpg' }] })
    const model = await trashItem(root, 'EX1', '模特/EX1/m1.jpg')
    expect(model.files).toEqual(['模特/EX1/m1.jpg'])
    const output = await trashItem(root, 'EX1', '成图/EX1/m1.png')
    expect(output.files).toEqual(['成图/EX1/m1.png'])
    expect(await present(root, '成图/EX1/m1.png')).toBe(false)
    expect((await readCollection(root)).redo).toEqual([])
    await restoreItem(root, 'EX1', output.id)
    await restoreItem(root, 'EX1', model.id)
    expect(await present(root, '成图/EX1/m1.png')).toBe(true)
    expect(await present(root, '模特/EX1/m1.jpg')).toBe(true)
  })

  it('refuses to delete while a run is going', async () => {
    const root = await makeRoot()
    await acquireRunLock(root, { runId: '20261016-000000', pid: process.pid, startedAt: new Date().toISOString() })
    await expect(trashItem(root, 'EX1', '服装/EX1/g1.jpg')).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    await releaseRunLock(root, '20261016-000000')
    expect(await present(root, '服装/EX1/g1.jpg')).toBe(true)
  })
})

describe('item order', () => {
  it('puts recorded files first in their order and keeps the rest in scan order', () => {
    expect(orderFiles(['a', 'b', 'c', 'd'], ['c', 'x', 'a'], (file) => file)).toEqual(['c', 'a', 'b', 'd'])
    expect(orderFiles(['a', 'b'], undefined, (file) => file)).toEqual(['a', 'b'])
  })

  it('reads old settings files without itemOrder', async () => {
    const root = await makeRoot()
    await updateCollection(root, (state) => { state.order = ['EX1'] })
    const file = path.join(root, '成图', '_runs', 'collection.json')
    const old = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    delete old.itemOrder
    await writeFile(file, JSON.stringify(old))
    expect((await readCollection(root)).itemOrder).toEqual({})
  })
})
