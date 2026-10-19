import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { bboxSchema } from '../contracts.js'
import { RunnerError } from '../errors.js'
import type { VisionPort } from '../ports.js'
import { createBriefCache, getGarmentBrief, type BriefCache } from '../prepare/brief.js'
import {
  orientedImageSize,
  prepareAsset,
  prepareFramingCopy,
  validateCropOverride,
  type PreparedAsset,
} from '../prepare/images.js'
import { buildTryonPrompt } from '../prepare/prompt.js'
import type { Asset, Bbox, BatchState, CropBox, Task } from './model.js'
import type { BatchStore } from './store.js'

export interface PrepareGroupDeps {
  vision: VisionPort
  signal: AbortSignal
}

// 每个批次一份进程内缓存：服装描述按 prepared 副本哈希缓存，定位按源图内容哈希去重
const briefCaches = new WeakMap<BatchStore, BriefCache>()
const locating = new WeakMap<BatchStore, Map<string, Promise<Bbox>>>()
// 同一素材的准备串行执行，避免旧裁切的写入晚于新裁切覆盖 prepared 文件
const preparing = new WeakMap<BatchStore, Map<string, Promise<void>>>()

function briefCacheOf(store: BatchStore): BriefCache {
  let cache = briefCaches.get(store)
  if (cache === undefined) {
    cache = createBriefCache()
    briefCaches.set(store, cache)
  }
  return cache
}

function locatingOf(store: BatchStore): Map<string, Promise<Bbox>> {
  let map = locating.get(store)
  if (map === undefined) {
    map = new Map()
    locating.set(store, map)
  }
  return map
}

function preparingOf(store: BatchStore): Map<string, Promise<void>> {
  let map = preparing.get(store)
  if (map === undefined) {
    map = new Map()
    preparing.set(store, map)
  }
  return map
}

function sameCrop(left: CropBox | undefined, right: CropBox | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  )
}

function sourcePathOf(store: BatchStore, asset: Asset): string {
  return path.join(store.resolve(store.state().sourceRoot), ...asset.relativePath.split('/'))
}

function findAsset(state: BatchState, assetId: string): Asset {
  const asset = state.assets.find((candidate) => candidate.id === assetId)
  if (asset === undefined) throw new RunnerError('NOT_FOUND', `Unknown asset: ${assetId}`)
  return asset
}

/** 组内仍在调度范围的任务（素材已变化的旧任务不再准备）。 */
function activeTasks(state: BatchState, groupId: string): Task[] {
  return state.tasks.filter(
    (task) => task.groupId === groupId && task.error?.code !== 'INPUT_CHANGED',
  )
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)]
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunnerError('ABORTED', 'Group preparation was aborted')
}

/** 定位服装 bbox：状态中已有同内容的 bbox 直接复用，进行中的同内容定位合并为一次调用。 */
async function locateBbox(
  store: BatchStore,
  asset: Asset,
  vision: VisionPort,
  signal: AbortSignal,
): Promise<Bbox> {
  const known = store.state().assets.find(
    (candidate) => candidate.contentHash === asset.contentHash && candidate.bbox !== undefined,
  )
  if (known?.bbox !== undefined) return known.bbox
  const inflight = locatingOf(store)
  const pending = inflight.get(asset.contentHash)
  if (pending !== undefined) return pending

  const work = (async () => {
    // 与旧流水线一致：先做一份压缩的全图临时副本交给视觉接口，用完即删
    const framingId = randomUUID()
    try {
      const copy = await prepareFramingCopy(
        { ...asset, sourcePath: sourcePathOf(store, asset) },
        { runDir: store.dir, framingId },
      )
      const frame = await vision.locateGarment(
        { imagePath: copy.path, contentHash: asset.contentHash },
        signal,
      )
      const parsed = bboxSchema.safeParse(frame.bbox)
      if (!parsed.success) {
        throw new RunnerError(
          'PROVIDER_RESPONSE',
          `Garment locator returned an invalid bbox for ${asset.relativePath}`,
        )
      }
      return parsed.data
    } finally {
      await rm(path.join(store.dir, 'prepared', `.framing-${framingId}`), {
        recursive: true,
        force: true,
      })
    }
  })()
  inflight.set(asset.contentHash, work)
  try {
    return await work
  } finally {
    inflight.delete(asset.contentHash)
  }
}

/** 已准备过的素材还原成 PreparedAsset，供服装描述缓存使用。 */
function preparedFromState(store: BatchStore, asset: Asset): PreparedAsset {
  if (asset.preparedRelativePath === undefined || asset.preparedHash === undefined) {
    throw new RunnerError('INTEGRITY_ERROR', `Asset is not prepared: ${asset.id}`)
  }
  return {
    assetId: asset.id,
    sourcePath: sourcePathOf(store, asset),
    path: store.resolve(asset.preparedRelativePath),
    relativePath: asset.preparedRelativePath,
    contentHash: asset.contentHash,
    preparedHash: asset.preparedHash,
    width: 0,
    height: 0,
    bytes: 0,
    cropped: asset.role === 'garment',
    warnings: [],
  }
}

async function ensurePrepared(
  store: BatchStore,
  assetId: string,
  deps: PrepareGroupDeps,
): Promise<void> {
  const chains = preparingOf(store)
  const previous = chains.get(assetId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => ensurePreparedNow(store, assetId, deps))
  chains.set(assetId, current)
  try {
    await current
  } finally {
    if (chains.get(assetId) === current) chains.delete(assetId)
  }
}

async function ensurePreparedNow(
  store: BatchStore,
  assetId: string,
  deps: PrepareGroupDeps,
): Promise<void> {
  aborted(deps.signal)
  let asset = findAsset(store.state(), assetId)
  if (asset.preparedHash !== undefined && asset.preparedRelativePath !== undefined) return
  if (asset.role === 'garment' && asset.cropOverride === undefined && asset.bbox === undefined) {
    const bbox = await locateBbox(store, asset, deps.vision, deps.signal)
    await store.update((draft) => {
      findAsset(draft, assetId).bbox = bbox
    })
    asset = findAsset(store.state(), assetId)
  }
  const prepared = await prepareAsset(
    {
      id: asset.id,
      role: asset.role,
      sourcePath: sourcePathOf(store, asset),
      relativePath: asset.relativePath,
      contentHash: asset.contentHash,
      bbox: asset.bbox,
      cropOverride: asset.cropOverride,
    },
    { runDir: store.dir },
  )
  await store.update((draft) => {
    const target = findAsset(draft, assetId)
    // 准备期间裁切框被改过：这份副本已过时，不落盘哈希，下一次 prepareGroup 重做
    if (!sameCrop(target.cropOverride, asset.cropOverride)) return
    target.preparedRelativePath = prepared.relativePath
    target.preparedHash = prepared.preparedHash
  })
}

async function promptFor(
  store: BatchStore,
  garmentId: string,
  scope: BatchState['settings']['scope'],
  deps: PrepareGroupDeps,
) {
  const garment = preparedFromState(store, findAsset(store.state(), garmentId))
  const brief = await getGarmentBrief(garment, scope, deps.vision, briefCacheOf(store), deps.signal)
  return { brief, prompt: buildTryonPrompt(brief, scope).prompt }
}

/**
 * 准备一组：全部素材有 prepared 副本、服装有 bbox、组有 brief 与 basePrompt。
 * fixedModel 模式下每件服装各自的 prompt 挂在对应任务的首个 PendingJob 上。
 * 准备失败记在组的 error 上（组状态 failed），不抛出；中止信号照常抛出。
 */
export async function prepareGroup(
  store: BatchStore,
  groupId: string,
  deps: PrepareGroupDeps,
): Promise<void> {
  const state = store.state()
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) throw new RunnerError('NOT_FOUND', `Unknown group: ${groupId}`)
  if (group.incompleteReason !== undefined) return
  const tasks = activeTasks(state, groupId)
  if (tasks.length === 0) return
  const mode = group.mode ?? state.settings.mode
  const scope = group.scope ?? state.settings.scope
  const garmentIds = uniqueIds(tasks.map((task) => task.garmentAssetId))
  const modelIds = uniqueIds(tasks.map((task) => task.modelAssetId))

  try {
    // 服装先行：定位失败时不再处理模特图
    for (const garmentId of garmentIds) await ensurePrepared(store, garmentId, deps)
    for (const modelId of modelIds) await ensurePrepared(store, modelId, deps)

    const current = store.state().groups.find((candidate) => candidate.id === groupId)
    if (current?.basePrompt === undefined || current.brief === undefined) {
      // 记下生成描述所用的服装副本哈希，落盘前核对，防止裁切中途变化后写入过时的 brief
      const usedHashes = new Map(
        garmentIds.map((id) => [id, findAsset(store.state(), id).preparedHash]),
      )
      const base = await promptFor(store, garmentIds[0]!, scope, deps)
      const perGarment = new Map<string, string>()
      if (mode === 'fixedModel') {
        for (const garmentId of garmentIds) {
          perGarment.set(garmentId, (await promptFor(store, garmentId, scope, deps)).prompt)
        }
      }
      await store.update((draft) => {
        const target = draft.groups.find((candidate) => candidate.id === groupId)
        if (target === undefined) return
        const stale = garmentIds.some((id) => {
          const hash = draft.assets.find((asset) => asset.id === id)?.preparedHash
          return hash === undefined || hash !== usedHashes.get(id)
        })
        if (stale) return
        target.brief = base.brief
        target.basePrompt = base.prompt
        for (const task of draft.tasks) {
          const prompt = perGarment.get(task.garmentAssetId)
          if (task.groupId !== groupId || prompt === undefined) continue
          const first = task.pending.find((job) => job.kind === 'first')
          if (first === undefined) {
            // 已有版本的任务不再补首轮作业
            if (task.versions.length === 0) {
              task.pending.unshift({ jobId: randomUUID(), kind: 'first', prompt })
            }
          } else if (first.submittedAt === undefined && first.providerRequestId === undefined) {
            // 已提交的作业 prompt 不可再改
            first.prompt = prompt
          }
        }
      })
    }
    await store.update((draft) => {
      const target = draft.groups.find((candidate) => candidate.id === groupId)
      if (target !== undefined) delete target.error
    })
  } catch (error) {
    if (deps.signal.aborted || (error instanceof RunnerError && error.code === 'ABORTED')) throw error
    const code = error instanceof RunnerError ? error.code : 'PROVIDER_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    await store.update((draft) => {
      const target = draft.groups.find((candidate) => candidate.id === groupId)
      if (target !== undefined) target.error = { code, message }
    })
  }
}

/**
 * 设置或清除（box 为 null）服装的手动裁切框。清除该素材的 prepared 哈希与相关组的
 * brief/basePrompt，下一次 prepareGroup 重新生成；已生成的版本不受影响。
 */
export async function setCropOverride(
  store: BatchStore,
  assetId: string,
  box: CropBox | null,
): Promise<void> {
  const asset = findAsset(store.state(), assetId)
  if (asset.role !== 'garment') {
    throw new RunnerError('VALIDATION_ERROR', '只有服装图可以手动裁切')
  }
  let validated: CropBox | undefined
  if (box !== null) {
    const size = await orientedImageSize(sourcePathOf(store, asset), asset.relativePath)
    validated = validateCropOverride(box, size.width, size.height)
  }
  await store.update((draft) => {
    const target = findAsset(draft, assetId)
    if (validated === undefined) delete target.cropOverride
    else target.cropOverride = validated
    delete target.preparedHash
    const groupIds = new Set(
      draft.tasks.filter((task) => task.garmentAssetId === assetId).map((task) => task.groupId),
    )
    for (const group of draft.groups) {
      if (!groupIds.has(group.id)) continue
      delete group.brief
      delete group.basePrompt
      // 未开始的组：手动裁切是自动裁切失败后的补救手段，清掉准备错误以便重新准备；
      // 已开始的组仍由"重试所有失败"恢复，避免裁切直接触发付费生成
      if (!group.started && group.delivered === undefined) delete group.error
    }
  })
}
