import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  BriefRequest,
  GarmentBrief,
  GarmentFrame,
  LocateGarmentRequest,
  VisionPort,
} from '../../src/ports.js'
import { buildTryonPrompt } from '../../src/prepare/prompt.js'
import { groupStatus, type PairingMode } from '../../src/studio/model.js'
import { prepareGroup, setCropOverride } from '../../src/studio/prepare.js'
import { mergeScan, scanSource } from '../../src/studio/scan.js'
import { openBatch, type BatchStore } from '../../src/studio/store.js'

const parents: string[] = []
const stores: BatchStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })))
})

let colorSeed = 0

/** 800×1000 的纯色 JPEG；颜色递增保证内容 hash 不同。 */
async function largeJpeg(): Promise<Buffer> {
  colorSeed += 1
  return sharp({
    create: {
      width: 800,
      height: 1000,
      channels: 3,
      background: { r: (colorSeed * 41) % 256, g: (colorSeed * 83) % 256, b: (colorSeed * 29) % 256 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

async function makeRoot(spec: Record<string, { garments: number; models: number }>): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'studio-prepare-'))
  parents.push(parent)
  const root = path.join(parent, '本次素材')
  for (const [sku, counts] of Object.entries(spec)) {
    await mkdir(path.join(root, sku, '服装'), { recursive: true })
    await mkdir(path.join(root, sku, '模特'), { recursive: true })
    for (let index = 1; index <= counts.garments; index += 1) {
      await writeFile(path.join(root, sku, '服装', `0${String(index)}.jpg`), await largeJpeg())
    }
    for (let index = 1; index <= counts.models; index += 1) {
      await writeFile(path.join(root, sku, '模特', `0${String(index)}.jpg`), await largeJpeg())
    }
  }
  return root
}

async function openScanned(root: string, mode: PairingMode = 'fixedClothing'): Promise<BatchStore> {
  const store = await openBatch(root)
  stores.push(store)
  const scanned = await scanSource(root)
  await store.update((draft) => {
    draft.settings.mode = mode
    const merged = mergeScan(draft, scanned)
    draft.groups = merged.groups
    draft.assets = merged.assets
    draft.tasks = merged.tasks
  })
  return store
}

class StubVision implements VisionPort {
  readonly locateCalls: LocateGarmentRequest[] = []
  readonly briefCalls: BriefRequest[] = []

  constructor(
    private readonly locate: (request: LocateGarmentRequest) => GarmentFrame = () => ({
      bbox: [100, 100, 900, 900],
    }),
  ) {}

  async locateGarment(request: LocateGarmentRequest): Promise<GarmentFrame> {
    this.locateCalls.push(request)
    return this.locate(request)
  }

  async brief(request: BriefRequest): Promise<GarmentBrief> {
    this.briefCalls.push(request)
    // 按图片内容区分服装，fixedModel 用例据此得到不同 prompt
    return {
      imageType: 'flat_lay',
      garments: [{ part: '上装', item: `测试上衣-${request.contentHash.slice(0, 6)}` }],
      suggestedPrompt: '',
      uncertainty: [],
    }
  }
}

function deps(vision: VisionPort): { vision: VisionPort; signal: AbortSignal } {
  return { vision, signal: new AbortController().signal }
}

function garmentOf(store: BatchStore, groupIndex = 0) {
  const state = store.state()
  const group = state.groups[groupIndex]!
  const task = state.tasks.find((candidate) => candidate.groupId === group.id)!
  return state.assets.find((asset) => asset.id === task.garmentAssetId)!
}

async function preparedSize(store: BatchStore, relativePath: string | undefined) {
  expect(relativePath).toBeDefined()
  const metadata = await sharp(store.resolve(relativePath!)).metadata()
  return { width: metadata.width, height: metadata.height }
}

// bbox [100,100,900,900] 在 800×1000 上加现有边距（20/22/20/34 按 1024 基准）后的裁切尺寸
const BBOX_CROP = { width: 672, height: 854 }

describe('prepareGroup', () => {
  it('crops the garment to bbox plus margins and locates each content hash only once', async () => {
    const root = await makeRoot({ A01: { garments: 1, models: 3 }, A02: { garments: 1, models: 3 } })
    // 两组共用同一张服装图（内容相同）
    await copyFile(path.join(root, 'A01', '服装', '01.jpg'), path.join(root, 'A02', '服装', '01.jpg'))
    const store = await openScanned(root)
    const vision = new StubVision()

    for (const group of store.state().groups) {
      await prepareGroup(store, group.id, deps(vision))
    }

    expect(vision.locateCalls).toHaveLength(1)
    const garment = garmentOf(store)
    expect(garment.bbox).toEqual([100, 100, 900, 900])
    expect(await preparedSize(store, garment.preparedRelativePath)).toEqual(BBOX_CROP)
    expect(garmentOf(store, 1).bbox).toEqual([100, 100, 900, 900])

    const state = store.state()
    const group = state.groups[0]!
    expect(group.brief).toBeDefined()
    expect(group.basePrompt).toBe(buildTryonPrompt(group.brief as GarmentBrief, 'full').prompt)
    // 模特图只压缩不裁切
    const modelTask = state.tasks.find((task) => task.groupId === group.id)!
    const model = state.assets.find((asset) => asset.id === modelTask.modelAssetId)!
    expect(model.preparedHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await preparedSize(store, model.preparedRelativePath)).toEqual({ width: 800, height: 1000 })
    expect(groupStatus(state, group.id)).toBe('idle')
  })

  it('uses the manual crop override, re-briefs, and returns to bbox crop when cleared', async () => {
    const root = await makeRoot({ A01: { garments: 1, models: 3 } })
    const store = await openScanned(root)
    const vision = new StubVision()
    const groupId = store.state().groups[0]!.id
    await prepareGroup(store, groupId, deps(vision))
    expect(vision.briefCalls).toHaveLength(1)

    const garmentId = garmentOf(store).id
    await setCropOverride(store, garmentId, { left: 100, top: 150, width: 400, height: 500 })
    expect(garmentOf(store).preparedHash).toBeUndefined()
    expect(store.state().groups[0]!.brief).toBeUndefined()
    expect(store.state().groups[0]!.basePrompt).toBeUndefined()

    await prepareGroup(store, groupId, deps(vision))
    expect(garmentOf(store).cropOverride).toEqual({ left: 100, top: 150, width: 400, height: 500 })
    expect(await preparedSize(store, garmentOf(store).preparedRelativePath)).toEqual({ width: 400, height: 500 })
    expect(vision.briefCalls).toHaveLength(2)
    expect(store.state().groups[0]!.basePrompt).toBeDefined()

    await setCropOverride(store, garmentId, null)
    await prepareGroup(store, groupId, deps(vision))
    expect(garmentOf(store).cropOverride).toBeUndefined()
    expect(await preparedSize(store, garmentOf(store).preparedRelativePath)).toEqual(BBOX_CROP)
    // bbox 已有，不重复定位
    expect(vision.locateCalls).toHaveLength(1)
  })

  it('does not keep a stale brief when the crop changes while preparation is in flight', async () => {
    const root = await makeRoot({ A01: { garments: 1, models: 3 } })
    const store = await openScanned(root)
    const groupId = store.state().groups[0]!.id
    const garmentId = garmentOf(store).id
    let releaseBrief: () => void = () => {}
    let briefStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      briefStarted = resolve
    })
    const vision = new StubVision()
    const originalBrief = vision.brief.bind(vision)
    let gated = true
    vision.brief = async (request) => {
      if (gated) {
        gated = false
        briefStarted()
        await new Promise<void>((resolve) => {
          releaseBrief = resolve
        })
      }
      return originalBrief(request)
    }

    const running = prepareGroup(store, groupId, deps(vision))
    await started
    // 描述生成过程中用户改了裁切框：旧裁切得到的 brief 不能落盘
    await setCropOverride(store, garmentId, { left: 100, top: 150, width: 400, height: 500 })
    releaseBrief()
    await running
    expect(store.state().groups[0]!.basePrompt).toBeUndefined()
    expect(garmentOf(store).preparedHash).toBeUndefined()

    await prepareGroup(store, groupId, deps(vision))
    expect(await preparedSize(store, garmentOf(store).preparedRelativePath)).toEqual({ width: 400, height: 500 })
    expect(vision.briefCalls).toHaveLength(2)
    expect(store.state().groups[0]!.basePrompt).toBeDefined()
  })

  it('rejects crop overrides outside the image or too small', async () => {
    const root = await makeRoot({ A01: { garments: 1, models: 3 } })
    const store = await openScanned(root)
    const garmentId = garmentOf(store).id
    for (const box of [
      { left: 500, top: 0, width: 400, height: 500 },
      { left: 0, top: 0, width: 100, height: 500 },
      { left: 0.5, top: 0, width: 400, height: 500 },
    ]) {
      await expect(setCropOverride(store, garmentId, box)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: '裁切框超出图片范围或过小',
      })
    }
    expect(garmentOf(store).cropOverride).toBeUndefined()
  })

  it('marks the group failed without writing a full-image copy when locating fails', async () => {
    const root = await makeRoot({ A01: { garments: 1, models: 3 } })
    const store = await openScanned(root)
    const vision = new StubVision(() => {
      throw new Error('vision down')
    })
    const groupId = store.state().groups[0]!.id
    await prepareGroup(store, groupId, deps(vision))

    const state = store.state()
    expect(groupStatus(state, groupId)).toBe('failed')
    expect(state.groups[0]!.error?.message).toContain('vision down')
    const garment = garmentOf(store)
    expect(garment.preparedHash).toBeUndefined()
    const fullCopy = await stat(store.resolve(`prepared/${garment.id}.jpg`)).then(() => true, () => false)
    expect(fullCopy).toBe(false)
    expect(state.groups[0]!.basePrompt).toBeUndefined()
  })

  it('stores a separate prompt on each fixedModel task', async () => {
    const root = await makeRoot({ A01: { garments: 2, models: 1 } })
    const store = await openScanned(root, 'fixedModel')
    const vision = new StubVision()
    const groupId = store.state().groups[0]!.id
    await prepareGroup(store, groupId, deps(vision))

    const tasks = store.state().tasks.filter((task) => task.groupId === groupId)
    expect(tasks).toHaveLength(2)
    const prompts = tasks.map((task) => task.pending[0]?.prompt)
    expect(tasks.every((task) => task.pending[0]?.kind === 'first')).toBe(true)
    expect(prompts[0]).toBeDefined()
    expect(prompts[1]).toBeDefined()
    expect(prompts[0]).not.toBe(prompts[1])
    expect(vision.briefCalls).toHaveLength(2)
    expect(groupStatus(store.state(), groupId)).toBe('idle')
  })
})
