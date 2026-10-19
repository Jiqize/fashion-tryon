import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { createEngine, type Engine, type EngineDeps, type EngineEvent } from '../../src/studio/engine.js'
import { createLimiter, type Limiter } from '../../src/studio/limiter.js'
import { mergeScan, scanSource } from '../../src/studio/scan.js'
import { openBatch, type BatchStore } from '../../src/studio/store.js'
import { Gate } from '../helpers/fake-image-generation.js'
import { cleanupSourceTrees, makeJpeg, makeSourceTree } from './helpers.js'

// 记录引擎内部创建的闸门，用于检查自适应并发的最终值（不依赖调度时序）
const createdLimiters = vi.hoisted(() => [] as Limiter[])
vi.mock('../../src/studio/limiter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/studio/limiter.js')>()
  return {
    ...original,
    createLimiter: (...args: Parameters<typeof original.createLimiter>) => {
      const limiter = original.createLimiter(...args)
      createdLimiters.push(limiter)
      return limiter
    },
  }
})

const engines: Engine[] = []
const stores: BatchStore[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()))
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await cleanupSourceTrees()
})

class StubVision implements VisionPort {
  async locateGarment(): Promise<GarmentFrame> {
    return { bbox: [250, 250, 750, 750] }
  }

  async brief(request: BriefRequest): Promise<GarmentBrief> {
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
  resumedFrom: string | undefined
  at: number
  active: number
}

/**
 * 假生图：前 rateLimited 次调用在提交阶段返回限流（服务商未受理，不回调 task ID）；
 * 无 checkpoint.providerRequestId 的调用计作一次上传+提交。
 */
class ScriptedImages implements ImageGenerationPort {
  readonly calls: CallRecord[] = []
  uploads = 0
  successes = 0
  active = 0
  /** 停在轮询阶段的调用数（task ID 已回调落盘） */
  held = 0
  private sequence = 0
  private rateLimitsReturned = 0
  // holdSuccesses：受理成功的调用等全部限流返回后再继续，保证降速先于任何一次成功
  private readonly successGate = new Gate()
  // holdAfterUploads：第 N 次之后受理的调用停在"轮询结果"阶段，直到中止
  private readonly pollGate = new Gate()

  constructor(
    private readonly options: {
      delayMs?: number
      rateLimitedDelayMs?: number
      rateLimited?: number
      holdSuccesses?: boolean
      holdAfterUploads?: number
      clock?: () => number
      fail?: (index: number) => Error | undefined
    } = {},
  ) {
    if (options.holdSuccesses === true && (options.rateLimited ?? 0) > 0) this.successGate.close()
    if (options.holdAfterUploads !== undefined) this.pollGate.close()
  }

  async generate(
    request: GenerateRequest,
    signal: AbortSignal,
    checkpoint?: GenerationCheckpoint,
  ): Promise<GeneratedImage> {
    const index = this.calls.length
    this.active += 1
    this.calls.push({
      request,
      resumedFrom: checkpoint?.providerRequestId,
      at: this.options.clock?.() ?? Date.now(),
      active: this.active,
    })
    try {
      const rateLimited = index < (this.options.rateLimited ?? 0)
      if (rateLimited) {
        await new Promise((resolve) => setTimeout(resolve, this.options.rateLimitedDelayMs ?? 40))
        this.rateLimitsReturned += 1
        if (this.rateLimitsReturned === this.options.rateLimited) {
          // 最后一个限流在本轮微任务里被引擎记录后再放行成功的调用
          setImmediate(() => this.successGate.open())
        }
        throw new RunnerError('PROVIDER_RATE_LIMIT', 'generation submit: apimart HTTP 429', { retryable: true })
      }
      await this.successGate.wait(signal)
      const failure = this.options.fail?.(index)
      if (failure !== undefined) throw failure
      // 上传并提交成功：立即回调 task ID，之后才是轮询等待
      if (checkpoint?.providerRequestId === undefined) {
        this.uploads += 1
        this.sequence += 1
        await checkpoint?.onProviderRequestId?.(`fake-${String(this.sequence)}`)
        if (this.uploads > (this.options.holdAfterUploads ?? Infinity)) {
          this.held += 1
          await this.pollGate.wait(signal)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 10))
      if (signal.aborted) throw new RunnerError('ABORTED', 'aborted')
      this.successes += 1
      return { bytes: await makeJpeg(), mediaType: 'image/jpeg' }
    } finally {
      this.active -= 1
    }
  }
}

/** 可控时钟：退避睡眠只推进虚拟时间，不真正等待。 */
function virtualClock(): { now: () => number; sleeps: number[]; sleep: NonNullable<EngineDeps['sleep']> } {
  let current = 0
  const sleeps: number[] = []
  return {
    now: () => current,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      current += ms
    },
  }
}

async function makeBatch(
  spec: Record<string, { garments: number; models: number }>,
  settings: { candidates?: 1 | 2 | 3 | 4; concurrency?: number } = {},
): Promise<{ root: string; store: BatchStore }> {
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
  return { root, store }
}

function engineFor(store: BatchStore, images: ImageGenerationPort, extra: Partial<EngineDeps> = {}): Engine {
  const engine = createEngine(store, { vision: new StubVision(), images, ...extra })
  engines.push(engine)
  return engine
}

/** 模拟进程退出：停引擎、关存储，再按同一素材根目录重开。 */
async function reopen(root: string, store: BatchStore, engine?: Engine): Promise<BatchStore> {
  await engine?.stop()
  await store.close()
  const reopened = await openBatch(root)
  stores.push(reopened)
  return reopened
}

describe('limiter adaptation', () => {
  it('halves on rate limit with exponential backoff and climbs back after 10 successes', () => {
    const limiter = createLimiter(5, { random: () => 0 })
    expect(limiter.effectiveLimit).toBe(5)

    expect(limiter.onRateLimited()).toBe(5000)
    expect(limiter.effectiveLimit).toBe(2)
    expect(limiter.onRateLimited()).toBe(10000)
    expect(limiter.effectiveLimit).toBe(1)
    expect(limiter.onRateLimited()).toBe(20000)
    expect(limiter.effectiveLimit).toBe(1)

    for (let index = 0; index < 9; index += 1) limiter.onSuccess()
    expect(limiter.effectiveLimit).toBe(1)
    limiter.onSuccess()
    expect(limiter.effectiveLimit).toBe(2)
    for (let index = 0; index < 40; index += 1) limiter.onSuccess()
    // 不超过用户设置的上限
    expect(limiter.effectiveLimit).toBe(5)
    expect(limiter.limit).toBe(5)

    // 成功后连续限流计数归零，退避从 5 秒重新开始；上限 60 秒并带 0–20% 抖动
    expect(limiter.onRateLimited()).toBe(5000)
    const jittered = createLimiter(5, { random: () => 0.999 })
    for (let index = 0; index < 5; index += 1) jittered.onRateLimited()
    const capped = jittered.onRateLimited()
    expect(capped).toBeGreaterThanOrEqual(60000)
    expect(capped).toBeLessThanOrEqual(72000)
  })

  it('keeps the degraded limit when the user limit changes but never exceeds it', () => {
    const limiter = createLimiter(8, { random: () => 0 })
    limiter.onRateLimited()
    expect(limiter.effectiveLimit).toBe(4)
    limiter.setLimit(3)
    expect(limiter.effectiveLimit).toBe(3)
    limiter.setLimit(10)
    expect(limiter.effectiveLimit).toBe(3)
    const fresh = createLimiter(5)
    fresh.setLimit(9)
    expect(fresh.effectiveLimit).toBe(9)
  })
})

describe('studio engine rate limiting', () => {
  it('backs off on rate limits, recovers, and never duplicates or overcounts generations', async () => {
    const clock = virtualClock()
    const images = new ScriptedImages({ rateLimited: 3, rateLimitedDelayMs: 80, delayMs: 40, holdSuccesses: true })
    const { store } = await makeBatch(
      { A01: { garments: 1, models: 12 }, A02: { garments: 1, models: 12 } },
      { concurrency: 5 },
    )
    const engine = engineFor(store, images, { sleep: clock.sleep, random: () => 0 })
    const limiter = createdLimiters.at(-1)!
    const events: EngineEvent[] = []
    engine.on('change', (event) => events.push(event))
    await engine.prepareAll()

    await engine.start()
    await engine.idle()

    const state = store.state()
    const notices = events.filter((event) => event.type === 'notice').map((event) => event.message)
    // 同一波并发的 3 次限流合并为一次降速：5 → 2
    expect(notices.filter((message) => message.startsWith('服务商限流'))).toEqual(['服务商限流，并发临时降到 2'])
    expect(clock.sleeps).toEqual([5000])
    expect(state.tasks).toHaveLength(24)
    expect(state.tasks.every((task) => task.status === 'done' && task.versions.length === 1)).toBe(true)
    expect(state.tasks.every((task) => task.pending.length === 0 && task.error === undefined)).toBe(true)
    expect(images.calls).toHaveLength(27)
    expect(images.successes).toBe(24)
    expect(state.generationCallsUsed).toBe(24)
    // 降速阶段新派发的调用最多 2 个同时进行
    expect(images.calls.slice(5, 13).every((call) => call.active <= 2)).toBe(true)
    expect(Math.max(...images.calls.map((call) => call.active))).toBeLessThanOrEqual(5)
    // 限流后至少 21 次成功：每 10 次回升 1，从 2 回到 4
    expect(limiter.limit).toBe(5)
    expect(limiter.effectiveLimit).toBe(4)
  }, 20_000)

  it('dispatches nothing during the backoff window', async () => {
    const clock = virtualClock()
    const images = new ScriptedImages({ rateLimited: 2, rateLimitedDelayMs: 5, delayMs: 5, clock: clock.now })
    const { store } = await makeBatch({ A01: { garments: 1, models: 3 } }, { concurrency: 1 })
    const engine = engineFor(store, images, { sleep: clock.sleep, random: () => 0.5 })

    await engine.start()
    await engine.idle()

    expect(clock.sleeps).toEqual([5500, 11000])
    expect(images.calls).toHaveLength(5)
    expect(images.calls[1]!.at - images.calls[0]!.at).toBeGreaterThanOrEqual(5000)
    expect(images.calls[2]!.at - images.calls[1]!.at).toBeGreaterThanOrEqual(10000)
    expect(store.state().tasks.every((task) => task.status === 'done')).toBe(true)
    expect(store.state().generationCallsUsed).toBe(3)
  })

  it('never runs the same job twice when a late rate limit arrives after the backoff ended', async () => {
    const clock = virtualClock()
    let releaseLate: (() => void) | undefined
    const perModel = new Map<string, number>()
    let concurrentSameJob = false
    const running = new Set<string>()
    const images: ImageGenerationPort = {
      async generate(request) {
        const seen = perModel.get(request.modelPath) ?? 0
        perModel.set(request.modelPath, seen + 1)
        if (running.has(request.modelPath)) concurrentSameJob = true
        running.add(request.modelPath)
        try {
          const order = [...perModel.keys()].indexOf(request.modelPath)
          if (seen === 0 && order === 0) {
            // 第一个作业：立即限流，触发降速与（瞬时的）退避
            throw new RunnerError('PROVIDER_RATE_LIMIT', 'generation submit: apimart HTTP 429', { retryable: true })
          }
          if (seen === 0 && order === 1) {
            // 同一轮派发的第二个作业：退避结束后才返回限流（合并，不再降速）
            await new Promise<void>((resolve) => {
              releaseLate = resolve
            })
            throw new RunnerError('PROVIDER_RATE_LIMIT', 'generation submit: apimart HTTP 429', { retryable: true })
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { bytes: await makeJpeg(), mediaType: 'image/jpeg' }
        } finally {
          running.delete(request.modelPath)
        }
      },
    }
    const { store } = await makeBatch({ A01: { garments: 1, models: 2 } }, { concurrency: 5 })
    const engine = engineFor(store, images, { sleep: clock.sleep, random: () => 0 })
    await engine.prepareAll()
    await engine.start()

    const started = Date.now()
    while (releaseLate === undefined || store.state().tasks.filter((task) => task.status === 'done').length < 1) {
      if (Date.now() - started > 5000) throw new Error('timed out waiting for the first retry')
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    // 迟到的限流返回后、其记录尚未落盘时，调度器被其他事件唤醒
    releaseLate()
    await new Promise((resolve) => setImmediate(resolve))
    engine.resume()
    await engine.idle()

    expect(concurrentSameJob).toBe(false)
    expect([...perModel.values()].sort()).toEqual([2, 2])
    const state = store.state()
    expect(state.tasks.every((task) => task.status === 'done' && task.versions.length === 1)).toBe(true)
    expect(state.generationCallsUsed).toBe(2)
  })

  it('does not resubmit an unknown submission until retried explicitly', async () => {
    const images = new ScriptedImages({
      fail: (index) => index === 0
        ? new RunnerError('PROVIDER_SUBMISSION_UNKNOWN', 'generation submit: HTTP 502; outcome unknown')
        : undefined,
    })
    const { store } = await makeBatch({ A01: { garments: 1, models: 2 } }, { concurrency: 1 })
    const engine = engineFor(store, images)

    await engine.start()
    await engine.idle()

    let state = store.state()
    const failed = state.tasks.filter((task) => task.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error).toEqual({
      code: 'PROVIDER_SUBMISSION_UNKNOWN',
      message: '提交结果未知，可能已计费；请确认后手动重试',
    })
    expect(failed[0]!.pending).toHaveLength(0)
    expect(images.calls).toHaveLength(2)

    await engine.retryFailed()
    await engine.idle()
    state = store.state()
    expect(state.tasks.every((task) => task.status === 'done')).toBe(true)
    expect(images.calls).toHaveLength(3)
  })
})

describe('studio engine crash recovery', () => {
  async function preparedBatch(): Promise<{ root: string; store: BatchStore }> {
    const batch = await makeBatch({ A01: { garments: 1, models: 2 } }, { concurrency: 2 })
    const engine = engineFor(batch.store, new ScriptedImages())
    await engine.prepareAll()
    await engine.stop()
    return batch
  }

  it('resumes a submitted job by polling its provider request without uploading again', async () => {
    const { root, store } = await preparedBatch()
    const taskId = store.state().tasks[0]!.id
    await store.update((draft) => {
      draft.groups[0]!.started = true
      const task = draft.tasks.find((candidate) => candidate.id === taskId)!
      task.status = 'running'
      task.pending = [{
        jobId: randomUUID(),
        kind: 'first',
        prompt: draft.groups[0]!.basePrompt!,
        providerRequestId: 'provider-task-1',
        submittedAt: new Date().toISOString(),
      }]
    })

    const reopened = await reopen(root, store)
    const images = new ScriptedImages()
    const engine = engineFor(reopened, images)
    await engine.idle()

    expect(images.calls).toHaveLength(1)
    expect(images.calls[0]!.resumedFrom).toBe('provider-task-1')
    expect(images.uploads).toBe(0)
    const task = reopened.state().tasks.find((candidate) => candidate.id === taskId)!
    expect(task.status).toBe('done')
    expect(task.versions).toHaveLength(1)
    expect(task.pending).toHaveLength(0)
    expect(task.chosenVersionId).toBe(task.versions[0]!.id)
    expect(reopened.state().generationCallsUsed).toBe(1)
  })

  it('fails a job that was submitted without a provider request ID instead of resubmitting', async () => {
    const { root, store } = await preparedBatch()
    const taskId = store.state().tasks[0]!.id
    await store.update((draft) => {
      draft.groups[0]!.started = true
      const task = draft.tasks.find((candidate) => candidate.id === taskId)!
      task.status = 'running'
      task.pending = [{
        jobId: randomUUID(),
        kind: 'first',
        prompt: draft.groups[0]!.basePrompt!,
        submittedAt: new Date().toISOString(),
      }]
    })

    const reopened = await reopen(root, store)
    const images = new ScriptedImages()
    const engine = engineFor(reopened, images)
    await engine.idle()

    expect(images.calls).toHaveLength(0)
    const task = reopened.state().tasks.find((candidate) => candidate.id === taskId)!
    expect(task.status).toBe('failed')
    expect(task.pending).toHaveLength(0)
    expect(task.error).toEqual({
      code: 'PROVIDER_SUBMISSION_UNKNOWN',
      message: '提交结果未知，可能已计费；请确认后手动重试',
    })
  })

  it('keeps finished versions after a mid-run stop and completes the rest after reopening', async () => {
    const { root, store } = await makeBatch({ A01: { garments: 1, models: 4 }, A02: { garments: 1, models: 4 } }, {
      concurrency: 2,
      candidates: 2,
    })
    // 第 5 次之后受理的调用停在轮询阶段：停止时一定有已拿到 task ID、尚未出结果的作业
    const first = new ScriptedImages({ delayMs: 25, holdAfterUploads: 5 })
    const engine = engineFor(store, first)
    await engine.prepareAll()
    await engine.start()
    const started = Date.now()
    // 只看"已拿到 task ID 的 pending 作业"不够：第 5 张可能正在写版本，停止后照样完成
    while (first.successes < 5 || first.held === 0) {
      if (Date.now() - started > 5000) throw new Error('timed out waiting for progress')
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await engine.stop()

    const before = store.state()
    const finished = new Map(before.tasks.map((task) => [task.id, task.versions.map((version) => version.id)]))
    const finishedCount = [...finished.values()].reduce((sum, ids) => sum + ids.length, 0)
    expect(finishedCount).toBeGreaterThanOrEqual(5)
    expect(finishedCount).toBeLessThan(16)

    const reopened = await reopen(root, store)
    const second = new ScriptedImages()
    const resumed = engineFor(reopened, second)
    await resumed.idle()

    const after = reopened.state()
    for (const task of after.tasks) {
      expect(task.status).toBe('done')
      expect(task.pending).toHaveLength(0)
      expect(task.versions).toHaveLength(2)
      // 已完成的版本原样保留
      const kept = finished.get(task.id)!
      expect(task.versions.slice(0, kept.length).map((version) => version.id)).toEqual(kept)
    }
    // 已拿到 task ID 的作业只续取结果，不重新上传提交
    expect(second.calls.some((call) => call.resumedFrom !== undefined)).toBe(true)
    expect(first.uploads + second.uploads).toBe(16)
    expect(after.generationCallsUsed).toBe(16)
  })
})
