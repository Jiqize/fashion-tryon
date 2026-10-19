import { randomUUID } from 'node:crypto'

import { MAX_CONCURRENCY } from '../config.js'
import { RunnerError } from '../errors.js'
import type { GeneratedImage, ImageGenerationPort, VisionPort } from '../ports.js'
import { createLimiter } from './limiter.js'
import { groupStatus, type BatchState, type Group, type Task, type Version } from './model.js'
import { prepareGroup } from './prepare.js'
import type { BatchStore } from './store.js'

export type EngineEvent =
  | { type: 'task'; taskId: string }
  | { type: 'group'; groupId: string }
  | { type: 'batch' }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }

export interface EngineDeps {
  vision: VisionPort
  images: ImageGenerationPort
  now?: () => Date
  /** 限流退避等待；测试注入可控时钟。停止时应尽快返回。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** 退避抖动的随机源 */
  random?: () => number
}

export interface Engine {
  prepareAll(): Promise<void>
  start(groupIds?: string[]): Promise<void>
  pause(): Promise<void>
  resume(): void
  setConcurrency(n: number): void
  enqueueRegen(taskId: string, job: { prompt: string; regen: Version['regen'] }): Promise<void>
  retryFailed(taskIds?: string[]): Promise<void>
  idle(): Promise<void>
  on(event: 'change', listener: (e: EngineEvent) => void): () => void
  stop(): Promise<void>
}

const MIN_CONCURRENCY = 1
// 后台准备（只调视觉接口）同时最多进行的组数
const PREPARE_PARALLEL = 2

interface Picked {
  groupId: string
  taskId: string
  jobId: string
  // 派发时的限流轮次：同一轮内并发返回的多次限流只算一次降速
  epoch: number
}

const SUBMISSION_UNKNOWN = {
  code: 'PROVIDER_SUBMISSION_UNKNOWN',
  message: '提交结果未知，可能已计费；请确认后手动重试',
} as const

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function findTask(state: BatchState, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) throw new RunnerError('NOT_FOUND', `Unknown task: ${taskId}`)
  return task
}

function findGroup(state: BatchState, groupId: string): Group {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) throw new RunnerError('NOT_FOUND', `Unknown group: ${groupId}`)
  return group
}

/** 素材已变化的旧任务不再调度。 */
function isActive(task: Task): boolean {
  return task.error?.code !== 'INPUT_CHANGED'
}

/** 组是否还需要准备：有待调度的任务，但服装描述、prompt 或素材副本缺失。 */
function needsPrepare(state: BatchState, groupId: string): boolean {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined || group.incompleteReason !== undefined || group.error !== undefined) return false
  const tasks = state.tasks.filter((task) => task.groupId === groupId && isActive(task))
  if (tasks.length === 0) return false
  if (group.brief === undefined || group.basePrompt === undefined) return true
  const prepared = (assetId: string) =>
    state.assets.find((asset) => asset.id === assetId)?.preparedHash !== undefined
  return tasks.some((task) => !prepared(task.garmentAssetId) || !prepared(task.modelAssetId))
}

/** 首轮作业补足到候选数（已有版本、已失败或素材已变化的任务不补）。 */
function topUpFirstJobs(task: Task, candidates: number): void {
  if (!isActive(task) || task.versions.length > 0 || task.status === 'failed') return
  const existing = task.pending.filter((job) => job.kind === 'first').length
  for (let index = existing; index < candidates; index += 1) {
    task.pending.push({ jobId: randomUUID(), kind: 'first' })
  }
}

function positionInGroup(state: BatchState, task: Task): number {
  return state.tasks.filter((candidate) => candidate.groupId === task.groupId).indexOf(task) + 1
}

function errorOf(error: unknown): { code: string; message: string } {
  // 提交结果未知：不自动重提，由用户确认后手动重试
  if (error instanceof RunnerError && error.code === 'PROVIDER_SUBMISSION_UNKNOWN') return { ...SUBMISSION_UNKNOWN }
  if (error instanceof RunnerError) return { code: error.code, message: error.message }
  return { code: 'PROVIDER_ERROR', message: error instanceof Error ? error.message : String(error) }
}

export function createEngine(store: BatchStore, deps: EngineDeps): Engine {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? defaultSleep
  const controller = new AbortController()
  const limiter = createLimiter(
    store.state().settings.concurrency,
    deps.random === undefined ? {} : { random: deps.random },
  )
  const listeners = new Set<(event: EngineEvent) => void>()
  // 正在运行的作业 jobId → taskId
  const inflight = new Map<string, string>()
  const running = new Set<Promise<void>>()
  const preparing = new Map<string, Promise<void>>()
  // 准备进行中又收到准备请求的组（如中途改了裁切）：本轮结束后再准备一次，避免过时结果被丢弃后无人补做
  const prepareAgain = new Set<string>()
  // 调度器已开始派发的组：按套优先，先把这些组的剩余作业派完
  const begun = new Set<string>()
  // 同一任务的版本写入串行，保证版本序号不冲突
  const versionChains = new Map<string, Promise<void>>()
  let idleWaiters: Array<() => void> = []
  let wakeup = deferred()
  let paused = false
  let stopped = false
  // 崩溃恢复完成前不派发
  let recovered = false
  // 限流退避：进行中时全局暂停派发
  let backoff: Promise<void> | undefined
  let rateEpoch = 0
  let stopping: Promise<void> | undefined

  function emit(event: EngineEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // 监听者的异常不影响引擎
      }
    }
  }

  function emitTask(state: BatchState, taskId: string): void {
    emit({ type: 'task', taskId })
    const task = state.tasks.find((candidate) => candidate.id === taskId)
    if (task !== undefined) emit({ type: 'group', groupId: task.groupId })
    emit({ type: 'batch' })
  }

  /** 按组 order 与按套优先挑出下一个可派发的作业。 */
  function pick(state: BatchState): Picked | undefined {
    const groups = state.groups
      .filter((group) => group.started && group.incompleteReason === undefined && group.error === undefined)
      .sort((left, right) => {
        const rank = Number(!begun.has(left.id)) - Number(!begun.has(right.id))
        return rank !== 0 ? rank : left.order - right.order
      })
    for (const group of groups) {
      for (const task of state.tasks) {
        if (task.groupId !== group.id || !isActive(task)) continue
        for (const job of task.pending) {
          // 已提交但没拿到 task ID 的作业不得重提（恢复时已按提交结果未知处理）；
          // 拿到 task ID 的作业照常派发，只续取结果
          if (job.submittedAt !== undefined && job.providerRequestId === undefined) continue
          if (inflight.has(job.jobId)) continue
          return { groupId: group.id, taskId: task.id, jobId: job.jobId, epoch: rateEpoch }
        }
      }
    }
    return undefined
  }

  function isIdle(): boolean {
    return recovered && inflight.size === 0 && preparing.size === 0 && pick(store.state()) === undefined
  }

  function checkIdle(): void {
    if (idleWaiters.length === 0 || !isIdle()) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  function notify(): void {
    const current = wakeup
    wakeup = deferred()
    current.resolve()
    checkIdle()
  }

  /**
   * 按作业与版本情况重算任务状态（调用前应已从 pending 中移除结束的作业）。
   * finishedJobId：已结束但仍留在 pending 的作业（如限流放回队首），不算运行中。
   */
  function settle(task: Task, finishedJobId?: string): void {
    if (task.pending.some((job) => job.jobId !== finishedJobId && inflight.has(job.jobId))) task.status = 'running'
    else if (task.pending.length > 0) task.status = 'queued'
    else if (task.versions.length > 0) task.status = 'done'
    else task.status = 'failed'
  }

  function ensureGroupPrepared(groupId: string): Promise<void> {
    const existing = preparing.get(groupId)
    if (existing !== undefined) {
      prepareAgain.add(groupId)
      return existing
    }
    if (!needsPrepare(store.state(), groupId)) return Promise.resolve()
    const work = (async () => {
      emit({ type: 'group', groupId })
      try {
        await prepareGroup(store, groupId, { vision: deps.vision, signal: controller.signal })
      } finally {
        preparing.delete(groupId)
        emit({ type: 'group', groupId })
        notify()
      }
      if (prepareAgain.delete(groupId) && !stopped) await ensureGroupPrepared(groupId)
    })()
    preparing.set(groupId, work)
    return work
  }

  async function prepareAll(): Promise<void> {
    const state = store.state()
    const ids = [...state.groups]
      .sort((left, right) => left.order - right.order)
      .filter((group) => needsPrepare(state, group.id))
      .map((group) => group.id)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < ids.length && !stopped) {
        const groupId = ids[next]!
        next += 1
        await ensureGroupPrepared(groupId).catch(() => undefined)
      }
    }
    await Promise.all(Array.from({ length: PREPARE_PARALLEL }, () => worker()))
  }

  async function recordVersion(picked: Picked, prompt: string, image: GeneratedImage): Promise<void> {
    const previous = versionChains.get(picked.taskId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const written = await store.writeVersionImage(picked.taskId, image.bytes, image.mediaType)
      let readySku: string | undefined
      const state = await store.update((draft) => {
        const before = groupStatus(draft, picked.groupId)
        const task = findTask(draft, picked.taskId)
        const index = task.pending.findIndex((job) => job.jobId === picked.jobId)
        const job = index >= 0 ? task.pending.splice(index, 1)[0] : undefined
        const version: Version = {
          id: randomUUID(),
          relativePath: written.relativePath,
          sha256: written.sha256,
          mediaType: image.mediaType,
          createdAt: now().toISOString(),
          prompt: job?.prompt ?? prompt,
          ...(job?.regen === undefined ? {} : { regen: job.regen }),
        }
        task.versions.push(version)
        // 首个版本默认采用；重出表示要新版本，直接采用新版本
        if (job?.kind === 'regen' || task.chosenVersionId === undefined) task.chosenVersionId = version.id
        delete task.error
        draft.generationCallsUsed += 1
        settle(task)
        if (before !== 'review' && groupStatus(draft, picked.groupId) === 'review') {
          readySku = findGroup(draft, picked.groupId).sku
        }
      })
      emitTask(state, picked.taskId)
      if (readySku !== undefined) {
        emit({ type: 'notice', level: 'info', message: `${readySku} 生成完成，可以判断了` })
      }
    })
    versionChains.set(picked.taskId, current)
    try {
      await current
    } finally {
      if (versionChains.get(picked.taskId) === current) versionChains.delete(picked.taskId)
    }
  }

  /** 从任务中移除失败的作业并记录原因；返回要发出的提示。 */
  function dropJobs(
    draft: BatchState,
    task: Task,
    jobIds: ReadonlySet<string>,
    failure: { code: string; message: string },
  ): { notice?: string; readySku?: string } {
    const result: { notice?: string; readySku?: string } = {}
    const before = groupStatus(draft, task.groupId)
    task.pending = task.pending.filter((job) => !jobIds.has(job.jobId))
    if (task.versions.length > 0) {
      const group = findGroup(draft, task.groupId)
      result.notice = `${group.sku} · ${String(positionInGroup(draft, task))} 重出失败：${failure.message}`
    } else {
      task.error = failure
    }
    settle(task)
    // 组内最后一个作业失败、但每个任务都已有版本时，这套同样进入待判断
    if (before !== 'review' && groupStatus(draft, task.groupId) === 'review') {
      result.readySku = findGroup(draft, task.groupId).sku
    }
    return result
  }

  function emitDropNotices(result: { notice?: string; readySku?: string }): void {
    if (result.notice !== undefined) emit({ type: 'notice', level: 'warn', message: result.notice })
    if (result.readySku !== undefined) {
      emit({ type: 'notice', level: 'info', message: `${result.readySku} 生成完成，可以判断了` })
    }
  }

  async function recordFailure(picked: Picked, error: unknown): Promise<void> {
    const failure = errorOf(error)
    let result: { notice?: string; readySku?: string } = {}
    const state = await store.update((draft) => {
      result = dropJobs(draft, findTask(draft, picked.taskId), new Set([picked.jobId]), failure)
    })
    emitTask(state, picked.taskId)
    emitDropNotices(result)
  }

  /**
   * 服务商限流（未受理）：作业放回队首、不计调用次数；同一轮派发的限流只降速一次，
   * 有效并发减半并全局暂停派发一段退避时间。
   */
  async function recordRateLimit(picked: Picked): Promise<void> {
    if (picked.epoch === rateEpoch) {
      rateEpoch += 1
      const waitMs = limiter.onRateLimited()
      const hold: Promise<void> = sleep(waitMs, controller.signal)
        .catch(() => undefined)
        .then(() => {
          if (backoff === hold) backoff = undefined
          notify()
        })
      backoff = hold
      emit({ type: 'notice', level: 'warn', message: `服务商限流，并发临时降到 ${String(limiter.effectiveLimit)}` })
    }
    // 记录落盘前作业仍占着运行集合（由 runJob 的 finally 移出），避免调度器提前再次派发同一作业
    const state = await store.update((draft) => {
      const task = findTask(draft, picked.taskId)
      const index = task.pending.findIndex((job) => job.jobId === picked.jobId)
      if (index > 0) task.pending.unshift(...task.pending.splice(index, 1))
      settle(task, picked.jobId)
    })
    emitTask(state, picked.taskId)
  }

  /**
   * 进程启动时恢复：拿到 task ID 的作业留在队列里只续取结果；
   * 只有提交时间、没有 task ID 的作业按提交结果未知处理，不重提；其余视为未提交正常排队。
   */
  async function recover(): Promise<void> {
    const touched: string[] = []
    const results: Array<{ notice?: string; readySku?: string }> = []
    const state = await store.update((draft) => {
      for (const task of draft.tasks) {
        const unknown = new Set(task.pending
          .filter((job) => job.providerRequestId === undefined && job.submittedAt !== undefined)
          .map((job) => job.jobId))
        if (unknown.size > 0) {
          results.push(dropJobs(draft, task, unknown, { ...SUBMISSION_UNKNOWN }))
          touched.push(task.id)
        } else if (task.status === 'running') {
          // 崩溃前运行中的任务回到排队
          settle(task)
          touched.push(task.id)
        }
      }
    })
    for (const taskId of touched) emitTask(state, taskId)
    for (const result of results) emitDropNotices(result)
  }

  async function runJob(picked: Picked, release: () => void): Promise<void> {
    try {
      // 准备期间裁切被改过时 prepareGroup 会丢弃过时结果，这里重新准备直到就绪（准备失败会记 error 并退出循环）
      while (!controller.signal.aborted && needsPrepare(store.state(), picked.groupId)) {
        await ensureGroupPrepared(picked.groupId)
      }
      if (controller.signal.aborted) return
      // 准备失败的组记了 error，作业留在队列里等 retryFailed
      if (findGroup(store.state(), picked.groupId).error !== undefined) return

      let prompt = ''
      let providerRequestId: string | undefined
      let garmentPath = ''
      let modelPath = ''
      // 提交前先把 prompt 落盘，任务进入 running
      const dispatched = await store.update((draft) => {
        const group = findGroup(draft, picked.groupId)
        const task = findTask(draft, picked.taskId)
        const job = task.pending.find((candidate) => candidate.jobId === picked.jobId)
        if (job === undefined) throw new RunnerError('INTEGRITY_ERROR', `Job is no longer pending: ${picked.jobId}`)
        if (job.prompt === undefined) {
          // 首轮 prompt：任务自己的（fixedModel 挂在首个作业上）优先，其次组的 basePrompt
          const own = task.pending.find((candidate) => candidate.kind === 'first' && candidate.prompt !== undefined)
          const resolved = own?.prompt ?? group.basePrompt
          if (resolved === undefined) {
            throw new RunnerError('INTEGRITY_ERROR', `Group has no prompt yet: ${group.sku}`)
          }
          // 同一任务的其余首轮候选用同一份 prompt
          for (const candidate of task.pending) {
            if (candidate.kind === 'first' && candidate.prompt === undefined && candidate.submittedAt === undefined) {
              candidate.prompt = resolved
            }
          }
        }
        prompt = job.prompt!
        providerRequestId = job.providerRequestId
        const garment = draft.assets.find((asset) => asset.id === task.garmentAssetId)
        const model = draft.assets.find((asset) => asset.id === task.modelAssetId)
        if (garment?.preparedRelativePath === undefined || model?.preparedRelativePath === undefined) {
          throw new RunnerError('INTEGRITY_ERROR', `Task assets are not prepared: ${task.id}`)
        }
        garmentPath = store.resolve(garment.preparedRelativePath)
        modelPath = store.resolve(model.preparedRelativePath)
        task.status = 'running'
      })
      emitTask(dispatched, picked.taskId)

      const settings = dispatched.settings
      const image = await deps.images.generate(
        { garmentPath, modelPath, prompt, model: settings.imageModel, size: settings.size },
        controller.signal,
        {
          // 已拿到 task ID 的作业只续取结果，不重新上传提交
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          onProviderRequestId: async (providerRequestId) => {
            const state = await store.update((draft) => {
              const job = findTask(draft, picked.taskId).pending.find((candidate) => candidate.jobId === picked.jobId)
              if (job === undefined) return
              job.providerRequestId = providerRequestId
              job.submittedAt = now().toISOString()
            })
            emitTask(state, picked.taskId)
          },
        },
      )
      limiter.onSuccess()
      await recordVersion(picked, prompt, image)
    } catch (error) {
      if (controller.signal.aborted) {
        // 停止（或模拟崩溃）：作业留在 pending，由重开后的恢复处理
        inflight.delete(picked.jobId)
        await store.update((draft) => {
          const task = draft.tasks.find((candidate) => candidate.id === picked.taskId)
          if (task !== undefined) settle(task)
        }).catch(() => undefined)
        return
      }
      if (error instanceof RunnerError && error.code === 'PROVIDER_RATE_LIMIT') {
        await recordRateLimit(picked).catch((failure: unknown) => {
          emit({ type: 'notice', level: 'warn', message: `记录限流结果出错：${errorOf(failure).message}` })
        })
        return
      }
      await recordFailure(picked, error).catch((failure: unknown) => {
        emit({ type: 'notice', level: 'warn', message: `记录失败结果出错：${errorOf(failure).message}` })
      })
    } finally {
      inflight.delete(picked.jobId)
      release()
      notify()
    }
  }

  async function loop(): Promise<void> {
    await recovering
    while (!stopped) {
      if (backoff !== undefined) {
        await backoff
        continue
      }
      if (paused || pick(store.state()) === undefined) {
        await wakeup.promise
        continue
      }
      let release: () => void
      try {
        release = await limiter.acquire(controller.signal)
      } catch {
        break
      }
      // 拿到名额后重新挑选：等待期间状态可能已变化
      const picked = paused || stopped || backoff !== undefined ? undefined : pick(store.state())
      if (picked === undefined) {
        release()
        continue
      }
      inflight.set(picked.jobId, picked.taskId)
      begun.add(picked.groupId)
      const work = runJob(picked, release)
      running.add(work)
      void work.finally(() => running.delete(work))
    }
  }

  const recovering = recover()
    .catch((error: unknown) => {
      emit({ type: 'notice', level: 'warn', message: `恢复未完成作业出错：${errorOf(error).message}` })
    })
    .finally(() => {
      recovered = true
      notify()
    })
  const looping = loop()
  // 引擎创建后在后台准备所有组，开跑前的素材表即可看到裁后图与提示词
  const backgroundPrepare = prepareAll().catch(() => undefined)

  return {
    prepareAll,

    async start(groupIds) {
      const candidates = store.state().settings.candidates
      const touched: string[] = []
      await store.update((draft) => {
        const targets = groupIds === undefined
          ? draft.groups.filter((group) => !group.started && group.delivered === undefined)
          : groupIds.map((groupId) => findGroup(draft, groupId))
        for (const group of targets) {
          if (group.incompleteReason !== undefined) continue
          group.started = true
          touched.push(group.id)
          for (const task of draft.tasks) {
            if (task.groupId !== group.id) continue
            topUpFirstJobs(task, candidates)
            if (task.pending.length > 0) settle(task)
          }
        }
      })
      for (const groupId of touched) emit({ type: 'group', groupId })
      if (touched.length > 0) emit({ type: 'batch' })
      notify()
    },

    async pause() {
      paused = true
      emit({ type: 'batch' })
      notify()
      await Promise.allSettled([...running])
    },

    resume() {
      paused = false
      emit({ type: 'batch' })
      notify()
    },

    setConcurrency(n) {
      if (!Number.isInteger(n) || n < MIN_CONCURRENCY || n > MAX_CONCURRENCY) {
        throw new RunnerError(
          'VALIDATION_ERROR',
          `并发数必须是 ${String(MIN_CONCURRENCY)}–${String(MAX_CONCURRENCY)} 的整数`,
        )
      }
      limiter.setLimit(n)
      notify()
      void store.update((draft) => {
        draft.settings.concurrency = n
      }).then(
        () => emit({ type: 'batch' }),
        (error: unknown) => emit({ type: 'notice', level: 'warn', message: `保存并发设置失败：${errorOf(error).message}` }),
      )
    },

    async enqueueRegen(taskId, job) {
      const state = await store.update((draft) => {
        const task = findTask(draft, taskId)
        if (!isActive(task)) throw new RunnerError('VALIDATION_ERROR', '素材已变化，此任务不能重出')
        task.pending.push({
          jobId: randomUUID(),
          kind: 'regen',
          prompt: job.prompt,
          ...(job.regen === undefined ? {} : { regen: job.regen }),
        })
        settle(task)
      })
      emitTask(state, taskId)
      notify()
    },

    async retryFailed(taskIds) {
      const selected = taskIds === undefined ? undefined : new Set(taskIds)
      const candidates = store.state().settings.candidates
      const touched: string[] = []
      const state = await store.update((draft) => {
        for (const task of draft.tasks) {
          if (selected !== undefined && !selected.has(task.id)) continue
          if (task.status !== 'failed' || !isActive(task)) continue
          // "重试所有失败"跳过已标记不交付的失败图（点名重试照常）
          if (selected === undefined && task.excluded) continue
          delete task.error
          task.status = 'queued'
          topUpFirstJobs(task, candidates)
          touched.push(task.id)
        }
        // 准备阶段失败的组：清除错误，派发前会重新准备
        for (const group of draft.groups) {
          if (group.error === undefined) continue
          const inScope = selected === undefined
            || draft.tasks.some((task) => task.groupId === group.id && selected.has(task.id))
          if (inScope) delete group.error
        }
      })
      for (const taskId of touched) emitTask(state, taskId)
      emit({ type: 'batch' })
      notify()
    },

    idle() {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
        checkIdle()
      })
    },

    on(_event, listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    stop() {
      stopping ??= (async () => {
        stopped = true
        controller.abort()
        notify()
        await looping
        await Promise.allSettled([...running])
        await Promise.allSettled([backgroundPrepare, ...preparing.values()])
      })()
      return stopping
    },
  }
}
