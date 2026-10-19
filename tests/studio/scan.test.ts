import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { batchStateSchema, type BatchState, type PairingMode } from '../../src/studio/model.js'
import { mergeScan, parseGroupDir, scanSource } from '../../src/studio/scan.js'
import { cleanupSourceTrees, makeJpeg, makeSourceTree } from './helpers.js'

afterEach(async () => {
  await cleanupSourceTrees()
})

function emptyState(mode: PairingMode = 'fixedClothing'): BatchState {
  return {
    schemaVersion: 1,
    batchId: 'batch_test',
    sourceRoot: '../本次素材',
    createdAt: '2026-09-25T00:00:00.000Z',
    settings: { mode, scope: 'full', candidates: 1, concurrency: 5, size: '3:4', imageModel: '' },
    groups: [],
    assets: [],
    tasks: [],
    generationCallsUsed: 0,
  }
}

function assetPath(state: BatchState, assetId: string): string {
  const asset = state.assets.find((candidate) => candidate.id === assetId)
  if (asset === undefined) throw new Error(`missing asset ${assetId}`)
  return asset.relativePath
}

describe('parseGroupDir', () => {
  it('splits sku and name at the first separator', () => {
    expect(parseGroupDir('EK52338_灰')).toEqual({ sku: 'EK52338', name: '灰' })
    expect(parseGroupDir('EK52338 灰 长款')).toEqual({ sku: 'EK52338', name: '灰 长款' })
    expect(parseGroupDir('EK52338')).toEqual({ sku: 'EK52338', name: '' })
  })
})

describe('scanSource + mergeScan', () => {
  it('builds fixedClothing tasks: first garment × every model', async () => {
    const root = await makeSourceTree({
      A01: { garments: 1, models: 4 },
      A02: { garments: 1, models: 4 },
      A03: { garments: 1, models: 4 },
      A04: { garments: 1, models: 4 },
    })
    const scanned = await scanSource(root)
    expect(scanned.map((group) => group.sku)).toEqual(['A01', 'A02', 'A03', 'A04'])
    const state = mergeScan(emptyState(), scanned)
    expect(batchStateSchema.parse(state)).toBeTruthy()
    expect(state.groups).toHaveLength(4)
    expect(state.groups.map((group) => group.order)).toEqual([0, 1, 2, 3])
    expect(state.tasks).toHaveLength(16)
    const firstGroup = state.groups[0]!
    const tasks = state.tasks.filter((task) => task.groupId === firstGroup.id)
    expect(tasks.map((task) => assetPath(state, task.garmentAssetId))).toEqual(Array(4).fill('A01/服装/01.jpg'))
    expect(tasks.map((task) => assetPath(state, task.modelAssetId))).toEqual([
      'A01/模特/01.jpg',
      'A01/模特/02.jpg',
      'A01/模特/03.jpg',
      'A01/模特/04.jpg',
    ])
    expect(tasks.every((task) => task.status === 'queued' && !task.excluded && task.pending.length === 0)).toBe(true)
  })

  it('marks a pair group with mismatched counts incomplete without affecting others', async () => {
    const root = await makeSourceTree({
      B01: { garments: 3, models: 4 },
      B02: { garments: 3, models: 3 },
    })
    const state = mergeScan(emptyState('pair'), await scanSource(root))
    const [bad, good] = state.groups
    expect(bad!.incompleteReason).toBe('一对一：服装 3 张 · 模特 4 张，数量不一致')
    expect(state.tasks.filter((task) => task.groupId === bad!.id)).toHaveLength(0)
    expect(good!.incompleteReason).toBeUndefined()
    const pairTasks = state.tasks.filter((task) => task.groupId === good!.id)
    expect(pairTasks.map((task) => [assetPath(state, task.garmentAssetId), assetPath(state, task.modelAssetId)])).toEqual([
      ['B02/服装/01.jpg', 'B02/模特/01.jpg'],
      ['B02/服装/02.jpg', 'B02/模特/02.jpg'],
      ['B02/服装/03.jpg', 'B02/模特/03.jpg'],
    ])
  })

  it('marks groups missing one side as incomplete', async () => {
    const root = await makeSourceTree({
      C01: { garments: 0, models: 3 },
      C02: { garments: 2, models: 0 },
    })
    const state = mergeScan(emptyState(), await scanSource(root))
    expect(state.groups.map((group) => group.incompleteReason)).toEqual(['缺少服装图', '缺少模特图'])
    expect(state.tasks).toHaveLength(0)
  })

  it('builds fixedModel tasks: every garment × first model', async () => {
    const root = await makeSourceTree({ D01: { garments: 3, models: 1 } })
    const state = mergeScan(emptyState('fixedModel'), await scanSource(root))
    expect(state.tasks).toHaveLength(3)
    expect(state.tasks.map((task) => assetPath(state, task.garmentAssetId))).toEqual([
      'D01/服装/01.jpg',
      'D01/服装/02.jpg',
      'D01/服装/03.jpg',
    ])
    expect(new Set(state.tasks.map((task) => assetPath(state, task.modelAssetId)))).toEqual(new Set(['D01/模特/01.jpg']))
  })

  it('ignores system files and the 成图 directory', async () => {
    const root = await makeSourceTree({ E01: { garments: 1, models: 3 } })
    await writeFile(path.join(root, 'E01', '模特', '._01.jpg'), await makeJpeg())
    await writeFile(path.join(root, 'E01', '模特', '.DS_Store'), 'x')
    await mkdir(path.join(root, '成图'), { recursive: true })
    await writeFile(path.join(root, '成图', 'x.jpg'), await makeJpeg())
    await mkdir(path.join(root, 'E01', '成图'), { recursive: true })
    await writeFile(path.join(root, 'E01', '成图', 'x.jpg'), await makeJpeg())
    const scanned = await scanSource(root)
    expect(scanned).toHaveLength(1)
    expect(scanned[0]!.garments).toHaveLength(1)
    expect(scanned[0]!.models).toHaveLength(3)
    const state = mergeScan(emptyState(), scanned)
    expect(state.tasks).toHaveLength(3)
    expect(state.assets.some((asset) => asset.relativePath.includes('成图') || asset.relativePath.includes('._'))).toBe(false)
  })

  it('parses sku and name from the group directory', async () => {
    const root = await makeSourceTree({ EK52338_灰: { garments: 1, models: 3 }, EK52339: { garments: 1, models: 3 } })
    const state = mergeScan(emptyState(), await scanSource(root))
    expect(state.groups.map((group) => ({ sku: group.sku, name: group.name, dir: group.dir }))).toEqual([
      { sku: 'EK52338', name: '灰', dir: 'EK52338_灰' },
      { sku: 'EK52339', name: '', dir: 'EK52339' },
    ])
  })

  it('ignores top-level directories without role subdirectories', async () => {
    const root = await makeSourceTree({ F01: { garments: 1, models: 3 } })
    await mkdir(path.join(root, '参考'), { recursive: true })
    await writeFile(path.join(root, '参考', 'a.jpg'), await makeJpeg())
    const scanned = await scanSource(root)
    expect(scanned.map((group) => group.dir)).toEqual(['F01'])
  })

  it('records group files outside role subdirectories as stray without building tasks from them', async () => {
    const root = await makeSourceTree({ F02: { garments: 1, models: 3 } })
    await writeFile(path.join(root, 'F02', 'loose.jpg'), await makeJpeg())
    await mkdir(path.join(root, 'F02', '参考'), { recursive: true })
    await writeFile(path.join(root, 'F02', '参考', 'ref.jpg'), await makeJpeg())
    const scanned = await scanSource(root)
    expect(scanned[0]!.stray).toEqual(['F02/loose.jpg', 'F02/参考/ref.jpg'])
    const state = mergeScan(emptyState(), scanned)
    expect(state.tasks).toHaveLength(3)
    expect(state.assets.some((asset) => asset.relativePath === 'F02/loose.jpg')).toBe(false)
  })

  it('keeps existing judgments and appends a task for a newly added model image', async () => {
    const root = await makeSourceTree({ G01: { garments: 1, models: 3 } })
    const first = mergeScan(emptyState(), await scanSource(root))
    const excludedId = first.tasks[0]!.id
    const judged: BatchState = structuredClone(first)
    judged.tasks[0]!.excluded = true
    await writeFile(path.join(root, 'G01', '模特', '04.jpg'), await makeJpeg())
    const second = mergeScan(judged, await scanSource(root))
    expect(second.tasks).toHaveLength(4)
    expect(second.tasks.find((task) => task.id === excludedId)!.excluded).toBe(true)
    const added = second.tasks.filter((task) => !first.tasks.some((old) => old.id === task.id))
    expect(added).toHaveLength(1)
    expect(added[0]!.status).toBe('queued')
    expect(assetPath(second, added[0]!.modelAssetId)).toBe('G01/模特/04.jpg')
    expect(second.groups).toHaveLength(1)
    // 纯函数：不修改传入的状态
    expect(judged.tasks).toHaveLength(3)
  })

  it('marks tasks whose source content changed as INPUT_CHANGED and adds new tasks', async () => {
    const root = await makeSourceTree({ H01: { garments: 1, models: 3 } })
    const first = mergeScan(emptyState(), await scanSource(root))
    const changedTaskId = first.tasks[1]!.id
    await writeFile(path.join(root, 'H01', '模特', '02.jpg'), await makeJpeg())
    const second = mergeScan(first, await scanSource(root))
    expect(second.tasks).toHaveLength(4)
    expect(second.tasks.find((task) => task.id === changedTaskId)!.error?.code).toBe('INPUT_CHANGED')
    expect(second.tasks.filter((task) => task.error === undefined)).toHaveLength(3)
  })

  it('appends new groups after existing ones and recomputes incompleteness', async () => {
    const root = await makeSourceTree({ I01: { garments: 1, models: 3 }, I02: { garments: 0, models: 3 } })
    const first = mergeScan(emptyState(), await scanSource(root))
    expect(first.groups[1]!.incompleteReason).toBe('缺少服装图')
    await writeFile(path.join(root, 'I02', '服装', '01.jpg'), await makeJpeg())
    await mkdir(path.join(root, 'I00', '服装'), { recursive: true })
    await mkdir(path.join(root, 'I00', '模特'), { recursive: true })
    await writeFile(path.join(root, 'I00', '服装', '01.jpg'), await makeJpeg())
    await writeFile(path.join(root, 'I00', '模特', '01.jpg'), await makeJpeg())
    const second = mergeScan(first, await scanSource(root))
    expect(second.groups.map((group) => [group.dir, group.order])).toEqual([
      ['I01', 0],
      ['I02', 1],
      ['I00', 2],
    ])
    expect(second.groups[1]!.incompleteReason).toBeUndefined()
    expect(second.tasks).toHaveLength(7)
  })

  it('produces identical task ids for identical input', async () => {
    const root = await makeSourceTree({ J01: { garments: 1, models: 3 } })
    const first = mergeScan(emptyState(), await scanSource(root))
    const again = mergeScan(emptyState(), await scanSource(root))
    expect(again.tasks.map((task) => task.id)).toEqual(first.tasks.map((task) => task.id))
    expect(mergeScan(first, await scanSource(root)).tasks.map((task) => task.id)).toEqual(first.tasks.map((task) => task.id))
  })

  it('warns when model count is outside 3–8 but still builds every task', async () => {
    const root = await makeSourceTree({ K01: { garments: 1, models: 9 } })
    const state = mergeScan(emptyState(), await scanSource(root))
    expect(state.tasks).toHaveLength(9)
    const models = state.assets.filter((asset) => asset.role === 'model')
    expect(models.every((asset) => asset.warnings.includes('模特图 9 张，超出常用的 3–8 张'))).toBe(true)
    // 重扫不重复追加
    const again = mergeScan(state, await scanSource(root))
    expect(again.assets.every((asset) => asset.warnings.length <= 1)).toBe(true)
  })

  it('does not warn about the model count in fixedModel mode, including group overrides', async () => {
    const root = await makeSourceTree({ L01: { garments: 3, models: 1 }, L02: { garments: 1, models: 1 } })
    const scanned = await scanSource(root)
    const modelWarnings = (state: BatchState, sku: string): string[] => {
      return state.assets
        .filter((asset) => asset.role === 'model' && asset.relativePath.startsWith(`${sku}/`))
        .flatMap((asset) => asset.warnings)
    }

    // 整批固定模特：1 张模特图不提示
    const fixedModel = mergeScan(emptyState('fixedModel'), scanned)
    expect(modelWarnings(fixedModel, 'L01')).toEqual([])
    expect(modelWarnings(fixedModel, 'L02')).toEqual([])

    // 整批固定服装，单组覆盖为固定模特：该组不提示，其它组照旧提示
    const base = mergeScan(emptyState(), scanned)
    expect(modelWarnings(base, 'L02')).toEqual(['模特图 1 张，超出常用的 3–8 张'])
    base.groups.find((group) => group.sku === 'L02')!.mode = 'fixedModel'
    const overridden = mergeScan(base, scanned)
    expect(modelWarnings(overridden, 'L02')).toEqual([])
    expect(modelWarnings(overridden, 'L01')).toEqual(['模特图 1 张，超出常用的 3–8 张'])

    // 整批固定模特，单组覆盖为固定服装：该组恢复提示
    fixedModel.groups.find((group) => group.sku === 'L02')!.mode = 'fixedClothing'
    expect(modelWarnings(mergeScan(fixedModel, scanned), 'L02')).toEqual(['模特图 1 张，超出常用的 3–8 张'])
  })
})
