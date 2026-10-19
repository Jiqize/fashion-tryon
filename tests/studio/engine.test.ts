import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { RunnerError } from '../../src/errors.js'
import type {
  BriefRequest,
  GarmentBrief,
  GarmentFrame,
  GenerateRequest,
  GeneratedImage,
  GenerationCheckpoint,
  ImageGenerationPort,
  VisionPort,
} from '../../src/ports.js'
import { createEngine, type Engine, type EngineEvent } from '../../src/studio/engine.js'
import { setCropOverride } from '../../src/studio/prepare.js'
import { mergeScan, scanSource } from '../../src/studio/scan.js'
import { openBatch, type BatchStore } from '../../src/studio/store.js'
import { Gate } from '../helpers/fake-image-generation.js'
import { cleanupSourceTrees, makeJpeg, makeSourceTree } from './helpers.js'

const engines: Engine[] = []
const stores: BatchStore[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()))
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await cleanupSourceTrees()
})

class StubVision implements VisionPort {
  briefCalls = 0
  onBrief: ((request: BriefRequest) => Promise<void>) | undefined

  async locateGarment(): Promise<GarmentFrame> {
    return { bbox: [250, 250, 750, 750] }
  }

  async brief(request: BriefRequest): Promise<GarmentBrief> {
    this.briefCalls += 1
    await this.onBrief?.(request)
    return {
      imageType: 'flat_lay',
      garments: [{ part: '上装', item: `测试上衣-${request.contentHash.slice(0, 6)}` }],
      suggestedPrompt: '',
      uncertainty: [],
    }
  }
}

interface CallRecord {
  request: GenerateRequest
  startedAt: number
}

/** 假生图：可配置延迟、按请求决定是否失败，记录调用顺序与最大并发。 */
class FakeImages implements ImageGenerationPort {
  readonly calls: CallRecord[] = []
  /** 关闭时调用停在受理之后，测试据此确定地观察并发 */
  readonly gate = new Gate()
  finished = 0
  active = 0
  maxActive = 0
  private sequence = 0

  constructor(
    private readonly delayMs = 20,
    private readonly fail: (request: GenerateRequest, attempt: number) => Error | undefined = () => undefined,
  ) {}

  async generate(
    request: GenerateRequest,
    signal: AbortSignal,
    checkpoint?: GenerationCheckpoint,
  ): Promise<GeneratedImage> {
    const attempt = this.calls.filter((call) => call.request.modelPath === request.modelPath).length
    this.calls.push({ request, startedAt: Date.now() })
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      this.sequence += 1
      await checkpoint?.onProviderRequestId?.(`fake-${String(this.sequence)}`)
      await this.gate.wait(signal)
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      const error = this.fail(request, attempt)
      if (error !== undefined) throw error
      return { bytes: await makeJpeg(), mediaType: 'image/jpeg' }
    } finally {
      this.active -= 1
      this.finished += 1
    }
  }
}

async function setup(
  spec: Record<string, { garments: number; models: number }>,
  images: ImageGenerationPort,
  settings: { candidates?: 1 | 2 | 3 | 4; concurrency?: number } = {},
  vision = new StubVision(),
): Promise<{ store: BatchStore; engine: Engine; vision: StubVision }> {
  const root = await makeSourceTree(spec)
  const store = await openBatch(root)
  stores.push(store)
  const scanned = await scanSource(root)
  await store.update((draft) => {
    if (settings.candidates !== undefined) draft.settings.candidates = settings.candidates
    if (settings.concurrency !== undefined) draft.settings.concurrency = settings.concurrency
    const merged = mergeScan(draft, scanned)
    draft.groups = merged.groups
    draft.assets = merged.assets
    draft.tasks = merged.tasks
  })
  const engine = createEngine(store, { vision, images })
  engines.push(engine)
  return { store, engine, vision }
}

function groupOfCall(store: BatchStore, call: CallRecord): string {
  const state = store.state()
  const model = state.assets.find((asset) => asset.preparedRelativePath !== undefined
    && store.resolve(asset.preparedRelativePath) === call.request.modelPath)!
  const task = state.tasks.find((candidate) => candidate.modelAssetId === model.id)!
  return state.groups.find((group) => group.id === task.groupId)!.sku
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('studio engine', () => {
  it('prepares all groups without generating images', async () => {
    const images = new FakeImages()
    const { store, engine } = await setup({ A01: { garments: 1, models: 3 }, A02: { garments: 1, models: 3 } }, images)

    await engine.prepareAll()

    const state = store.state()
    for (const group of state.groups) {
      expect(group.error).toBeUndefined()
      expect(group.basePrompt).toBeDefined()
      const task = state.tasks.find((candidate) => candidate.groupId === group.id)!
      const garment = state.assets.find((asset) => asset.id === task.garmentAssetId)!
      expect(garment.preparedRelativePath).toBeDefined()
    }
    expect(images.calls).toHaveLength(0)
  })

  it('generates every task within the concurrency limit', async () => {
    const images = new FakeImages(5)
    const { store, engine } = await setup(
      { A01: { garments: 1, models: 4 }, A02: { garments: 1, models: 4 }, A03: { garments: 1, models: 4 } },
      images,
      { concurrency: 2 },
    )

    // 闸门关闭时调用全部停住：并发一定能打满到上限，而且不会超过
    images.gate.close()
    await engine.start()
    await waitFor(() => images.active === 2)
    expect(images.calls).toHaveLength(2)
    images.gate.open()
    await engine.idle()

    const state = store.state()
    expect(state.tasks).toHaveLength(12)
    expect(state.tasks.every((task) => task.status === 'done' && task.versions.length === 1)).toBe(true)
    expect(state.tasks.every((task) => task.pending.length === 0)).toBe(true)
    expect(state.groups.every((group) => group.started)).toBe(true)
    expect(images.maxActive).toBe(2)
    expect(images.calls).toHaveLength(12)
    expect(state.generationCallsUsed).toBe(12)
    // 生图请求带上组的 prompt 与准备好的图片
    const group = state.groups[0]!
    expect(images.calls.some((call) => call.request.prompt === group.basePrompt)).toBe(true)
  })

  it('creates one version per candidate and chooses the first arrival', async () => {
    const images = new FakeImages(10)
    const { store, engine } = await setup({ A01: { garments: 1, models: 3 } }, images, { candidates: 3 })

    await engine.start()
    await engine.idle()

    const state = store.state()
    expect(images.calls).toHaveLength(9)
    for (const task of state.tasks) {
      expect(task.versions).toHaveLength(3)
      expect(task.chosenVersionId).toBe(task.versions[0]!.id)
      expect(task.status).toBe('done')
    }
    expect(state.generationCallsUsed).toBe(9)
  })

  it('finishes dispatching one group before starting the next', async () => {
    const images = new FakeImages(15)
    const { store, engine } = await setup(
      { A01: { garments: 1, models: 4 }, B01: { garments: 1, models: 4 } },
      images,
      { concurrency: 2 },
    )
    await engine.prepareAll()

    await engine.start()
    await engine.idle()

    const order = images.calls.map((call) => groupOfCall(store, call))
    expect(order).toEqual(['A01', 'A01', 'A01', 'A01', 'B01', 'B01', 'B01', 'B01'])
  })

  it('applies a new concurrency limit while running and validates the range', async () => {
    // 用闸门停住调用，按事件断言并发，不依赖生成耗时与落盘速度
    const images = new FakeImages(5)
    const { store, engine } = await setup(
      { A01: { garments: 1, models: 6 }, A02: { garments: 1, models: 6 } },
      images,
      { concurrency: 1 },
    )
    await engine.prepareAll()

    images.gate.close()
    await engine.start()
    await waitFor(() => images.active === 1)
    expect(images.calls).toHaveLength(1)
    engine.setConcurrency(4)
    // 调高上限立即放行排队的作业，直到 4 个同时停在闸门处
    await waitFor(() => images.active === 4)
    expect(images.calls).toHaveLength(4)
    images.gate.open()
    await engine.idle()

    expect(images.maxActive).toBe(4)
    expect(images.calls).toHaveLength(12)
    await waitFor(() => store.state().settings.concurrency === 4)
    let thrown: unknown
    try {
      engine.setConcurrency(11)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RunnerError)
    expect((thrown as RunnerError).code).toBe('VALIDATION_ERROR')
    expect(store.state().settings.concurrency).toBe(4)
  })

  it('pauses dispatching while running jobs finish, then resumes', async () => {
    const images = new FakeImages(30)
    const { store, engine } = await setup({ A01: { garments: 1, models: 6 } }, images, { concurrency: 2 })
    await engine.prepareAll()

    await engine.start()
    await waitFor(() => images.calls.length >= 2)
    await engine.pause()

    const started = images.calls.length
    expect(images.finished).toBe(started)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(images.calls.length).toBe(started)
    expect(started).toBeLessThan(6)

    engine.resume()
    await engine.idle()
    expect(images.calls).toHaveLength(6)
    expect(store.state().tasks.every((task) => task.status === 'done')).toBe(true)
  })

  it('marks a task failed on provider error and succeeds after retryFailed', async () => {
    let failingModel: string | undefined
    const images = new FakeImages(5, (request, attempt) => {
      failingModel ??= request.modelPath
      if (request.modelPath === failingModel && attempt === 0) {
        return new RunnerError('PROVIDER_ERROR', 'fake provider failure')
      }
      return undefined
    })
    const { store, engine } = await setup({ A01: { garments: 1, models: 3 } }, images, { concurrency: 1 })

    await engine.start()
    await engine.idle()

    let state = store.state()
    const failed = state.tasks.filter((task) => task.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error?.code).toBe('PROVIDER_ERROR')
    expect(failed[0]!.pending).toHaveLength(0)
    expect(state.tasks.filter((task) => task.status === 'done')).toHaveLength(2)
    expect(state.generationCallsUsed).toBe(2)

    await engine.retryFailed()
    await engine.idle()

    state = store.state()
    expect(state.tasks.every((task) => task.status === 'done')).toBe(true)
    expect(state.tasks.every((task) => task.error === undefined)).toBe(true)
    expect(state.generationCallsUsed).toBe(3)
  })

  it('skips failed tasks marked not-to-deliver when retrying all failures', async () => {
    const images = new FakeImages(5, (_request, attempt) =>
      attempt === 0 ? new RunnerError('PROVIDER_ERROR', 'fake provider failure') : undefined)
    const { store, engine } = await setup({ A01: { garments: 1, models: 2 } }, images, { concurrency: 1 })
    await engine.start()
    await engine.idle()
    const [first, second] = store.state().tasks
    expect(store.state().tasks.every((task) => task.status === 'failed')).toBe(true)
    await store.update((draft) => {
      draft.tasks[0]!.excluded = true
    })

    await engine.retryFailed()
    await engine.idle()

    // 已标记不交付的失败图不再计费重试；点名重试时照常重试
    expect(store.state().tasks.find((task) => task.id === first!.id)!.status).toBe('failed')
    expect(store.state().tasks.find((task) => task.id === second!.id)!.status).toBe('done')
    await engine.retryFailed([first!.id])
    await engine.idle()
    expect(store.state().tasks.find((task) => task.id === first!.id)!.status).toBe('done')
  })

  it('appends a regenerated version and chooses it', async () => {
    const images = new FakeImages(5)
    const { store, engine } = await setup({ A01: { garments: 1, models: 3 } }, images)
    await engine.start()
    await engine.idle()

    const task = store.state().tasks[0]!
    const original = task.versions[0]!
    await engine.enqueueRegen(task.id, {
      prompt: 'regen prompt',
      regen: { tags: ['color', 'other'], note: '颜色偏黄', fromVersionId: original.id },
    })
    await engine.idle()

    const updated = store.state().tasks.find((candidate) => candidate.id === task.id)!
    expect(updated.versions).toHaveLength(2)
    expect(updated.versions[0]).toEqual(original)
    const regenerated = updated.versions[1]!
    expect(updated.chosenVersionId).toBe(regenerated.id)
    expect(regenerated.prompt).toBe('regen prompt')
    expect(regenerated.regen).toEqual({ tags: ['color', 'other'], note: '颜色偏黄', fromVersionId: original.id })
    expect(updated.status).toBe('done')
    expect(updated.pending).toHaveLength(0)
    expect(images.calls.at(-1)!.request.prompt).toBe('regen prompt')
  })

  it('announces a group when all its tasks are ready for review', async () => {
    const images = new FakeImages(5)
    const { engine } = await setup({ A01: { garments: 1, models: 3 }, A02: { garments: 1, models: 3 } }, images)
    const events: EngineEvent[] = []
    engine.on('change', (event) => events.push(event))

    await engine.start()
    await engine.idle()

    const notices = events.filter((event) => event.type === 'notice').map((event) => event.message)
    expect(notices).toContain('A01 生成完成，可以判断了')
    expect(notices).toContain('A02 生成完成，可以判断了')
    expect(events.some((event) => event.type === 'task')).toBe(true)
    expect(events.some((event) => event.type === 'group')).toBe(true)
    expect(events.some((event) => event.type === 'batch')).toBe(true)
  })

  it('announces review when the last job of a group fails but every task has a version', async () => {
    const images = new FakeImages(5, (_request, attempt) =>
      attempt === 1 ? new RunnerError('PROVIDER_ERROR', 'fake provider failure') : undefined)
    const { store, engine } = await setup({ A01: { garments: 1, models: 1 } }, images, { candidates: 2, concurrency: 1 })
    const events: EngineEvent[] = []
    engine.on('change', (event) => events.push(event))

    await engine.start()
    await engine.idle()

    const task = store.state().tasks[0]!
    expect(task.status).toBe('done')
    expect(task.versions).toHaveLength(1)
    const notices = events.filter((event) => event.type === 'notice').map((event) => event.message)
    expect(notices).toContain('A01 生成完成，可以判断了')
  })

  it('re-prepares a group whose crop changed mid-preparation instead of failing its tasks', async () => {
    const vision = new StubVision()
    let store: BatchStore | undefined
    let changed = false
    // 第一次生成服装描述时模拟用户改了裁切框：清掉 prepared 哈希与组 prompt
    vision.onBrief = async () => {
      if (changed || store === undefined) return
      changed = true
      await store.update((draft) => {
        const group = draft.groups[0]!
        const task = draft.tasks.find((candidate) => candidate.groupId === group.id)!
        delete draft.assets.find((asset) => asset.id === task.garmentAssetId)!.preparedHash
        delete group.brief
        delete group.basePrompt
      })
    }
    const images = new FakeImages(5)
    const root = await makeSourceTree({ A01: { garments: 1, models: 2 } })
    store = await openBatch(root)
    stores.push(store)
    const scanned = await scanSource(root)
    await store.update((draft) => {
      const merged = mergeScan(draft, scanned)
      draft.groups = merged.groups
      draft.assets = merged.assets
      draft.tasks = merged.tasks
    })
    const engine = createEngine(store, { vision, images })
    engines.push(engine)

    await engine.start()
    await engine.idle()

    const state = store.state()
    expect(changed).toBe(true)
    expect(state.tasks.every((task) => task.status === 'done' && task.error === undefined)).toBe(true)
    expect(images.calls).toHaveLength(2)
    expect(images.calls.every((call) => call.request.prompt === state.groups[0]!.basePrompt)).toBe(true)
  })

  it('prepares again when a crop is saved while background preparation is in flight', async () => {
    const vision = new StubVision()
    let release: () => void = () => {}
    let briefStarted = false
    // 只拦住第一次生成服装描述，模拟后台准备进行中
    vision.onBrief = async () => {
      if (briefStarted) return
      briefStarted = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const root = await makeSourceTree({ A01: { garments: 1, models: 2 } })
    // 足够大的服装图，手动裁切框才能满足最小短边
    await writeFile(
      path.join(root, 'A01', '服装', '01.jpg'),
      await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 180, g: 120, b: 90 } } }).jpeg().toBuffer(),
    )
    const store = await openBatch(root)
    stores.push(store)
    const scanned = await scanSource(root)
    await store.update((draft) => {
      Object.assign(draft, mergeScan(draft, scanned))
    })
    const engine = createEngine(store, { vision, images: new FakeImages() })
    engines.push(engine)
    await waitFor(() => briefStarted)

    const garmentId = store.state().tasks[0]!.garmentAssetId
    try {
      await setCropOverride(store, garmentId, { left: 100, top: 150, width: 400, height: 500 })
      // 服务端保存裁切后会再请求一次后台准备，此时上一轮仍在进行
      const again = engine.prepareAll()
      release()
      await again
    } finally {
      release()
    }

    const state = store.state()
    const garment = state.assets.find((asset) => asset.id === garmentId)!
    expect(garment.cropOverride).toEqual({ left: 100, top: 150, width: 400, height: 500 })
    expect(garment.preparedHash).toBeDefined()
    expect(state.groups[0]!.basePrompt).toBeDefined()
    expect(vision.briefCalls).toBe(2)
  })
})
