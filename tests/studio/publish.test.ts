import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDecisions } from '../../src/studio/decisions.js'
import type { Engine } from '../../src/studio/engine.js'
import { publishGroup, writeOverview } from '../../src/studio/publish.js'
import type { BatchStore } from '../../src/studio/store.js'
import { cleanupSourceTrees, makeJpeg, makeReviewBatch } from './helpers.js'

const stores: BatchStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await cleanupSourceTrees()
})

// 交付测试不涉及重出，引擎替身不会被调用
const noEngine = {} as Engine

describe('publish', () => {
  it('delivers non-excluded chosen versions with sku_model file names', async () => {
    const { root, store } = await makeReviewBatch({ EK52338: { garments: 1, models: 4 } })
    stores.push(store)
    const decisions = createDecisions(store, noEngine)
    const excluded = store.state().tasks[1]!
    await decisions.apply({ op: 'exclude', taskId: excluded.id, excluded: true })

    const result = await decisions.apply({ op: 'pass', groupId: store.state().groups[0]!.id })

    expect(result).toMatchObject({ ok: true, message: 'EK52338 已交付 3 张' })
    const files = (await readdir(path.join(root, '成图', 'EK52338'))).sort()
    expect(files).toEqual(['EK52338_01.jpg', 'EK52338_03.jpg', 'EK52338_04.jpg'])
    // 交付的是采用版本的原始字节
    const chosen = store.state().tasks[0]!
    const version = chosen.versions.find((candidate) => candidate.id === chosen.chosenVersionId)!
    expect(await readFile(path.join(root, '成图', 'EK52338', 'EK52338_01.jpg')))
      .toEqual(await readFile(store.resolve(version.relativePath)))
    expect(store.state().groups[0]!.delivered?.files).toEqual([
      '成图/EK52338/EK52338_01.jpg',
      '成图/EK52338/EK52338_03.jpg',
      '成图/EK52338/EK52338_04.jpg',
    ])
  })

  it('skips identical files when a group is delivered again', async () => {
    const { root, store } = await makeReviewBatch({ EK52338: { garments: 1, models: 3 } })
    stores.push(store)
    const decisions = createDecisions(store, noEngine)
    const groupId = store.state().groups[0]!.id
    await decisions.apply({ op: 'pass', groupId })
    await decisions.apply({ op: 'withdraw', groupId })

    const again = await decisions.apply({ op: 'pass', groupId })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.published?.files).toEqual([])
    expect(again.published?.skippedSame).toHaveLength(3)
    expect(await readdir(path.join(root, '成图', 'EK52338'))).toHaveLength(3)
  })

  it('never overwrites a different existing file and adds a numeric suffix', async () => {
    const { root, store } = await makeReviewBatch(
      { EK52338: { garments: 1, models: 1 } },
      { renameModels: { 'EK52338/模特/01.jpg': 'EK52338/模特/2.jpg' } },
    )
    stores.push(store)
    const outputDir = path.join(root, '成图', 'EK52338')
    await mkdir(outputDir, { recursive: true })
    const existing = await makeJpeg()
    await writeFile(path.join(outputDir, 'EK52338_2.jpg'), existing)

    const result = await publishGroup(store, store.state().groups[0]!.id)

    expect(result.files).toEqual(['成图/EK52338/EK52338_2_2.jpg'])
    expect(await readFile(path.join(outputDir, 'EK52338_2.jpg'))).toEqual(existing)
  })

  it('names fixedModel outputs after the garment file', async () => {
    const { root, store } = await makeReviewBatch({ EK52338: { garments: 2, models: 1 } }, { mode: 'fixedModel' })
    stores.push(store)

    await publishGroup(store, store.state().groups[0]!.id)

    expect((await readdir(path.join(root, '成图', 'EK52338'))).sort()).toEqual(['EK52338_01.jpg', 'EK52338_02.jpg'])
  })

  it('writes an overview page and a BOM-prefixed mapping csv', async () => {
    const { store } = await makeReviewBatch({ EK52338: { garments: 1, models: 3 }, EK60001: { garments: 1, models: 2 } })
    stores.push(store)
    const decisions = createDecisions(store, noEngine)
    const [first, second] = store.state().groups
    await decisions.apply({ op: 'pass', groupId: first!.id })
    await decisions.apply({ op: 'pass', groupId: second!.id })

    const { htmlPath, csvPath } = await writeOverview(store)

    const csv = await readFile(csvPath, 'utf8')
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).trim().split('\n')
    expect(lines[0]).toBe('sku,task_id,garment,model,version_id,output_file')
    expect(lines).toHaveLength(5 + 1)
    expect(lines[1]).toContain('成图/EK52338/EK52338_01.jpg')
    const html = await readFile(htmlPath, 'utf8')
    expect(path.basename(htmlPath)).toBe('总览.html')
    expect(html).toContain('EK52338')
    expect(html).toContain('EK60001')
    expect(html).toMatch(/src="thumbs\//)

    // 撤回后重写：只剩一个组的行
    await decisions.apply({ op: 'withdraw', groupId: second!.id })
    const rewritten = await readFile(csvPath, 'utf8')
    expect(rewritten.slice(1).trim().split('\n')).toHaveLength(3 + 1)
  })
})
