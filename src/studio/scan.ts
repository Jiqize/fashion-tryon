import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'
import { compareCodePoints, roleOfSegment, scanInput, stableId, type ScannedFile } from './fs-scan.js'
import type { Asset, BatchState, Group, PairingMode, Task } from './model.js'

export type { ScannedFile } from './fs-scan.js'

export interface ScannedGroup {
  sku: string
  name: string
  /** 组目录，相对素材根目录 */
  dir: string
  garments: ScannedFile[]
  models: ScannedFile[]
  /** 组内不在角色子目录下的文件（相对素材根目录） */
  stray: string[]
}

export type TaskSeed = Pick<Task, 'id' | 'garmentAssetId' | 'modelAssetId'>

// 与扫描器保留目录一致：一级目录里这些名字不可能是组
const RESERVED_GROUP_NAMES = new Set(['.git', 'node_modules', '成图'])

const MODEL_COUNT_MIN = 3
const MODEL_COUNT_MAX = 8
const MODEL_COUNT_WARNING = /^模特图 \d+ 张，超出常用的 3–8 张$/

function modelCountWarning(count: number): string {
  return `模特图 ${String(count)} 张，超出常用的 3–8 张`
}

/** 目录名按第一个 `_` 或空格拆成款号与名称。 */
export function parseGroupDir(dirName: string): { sku: string; name: string } {
  const trimmed = dirName.trim()
  const match = /[_ ]/.exec(trimmed)
  if (match === null) return { sku: trimmed, name: '' }
  return { sku: trimmed.slice(0, match.index).trim(), name: trimmed.slice(match.index + 1).trim() }
}

async function listDirectories(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    throw new RunnerError('IO_ERROR', `Cannot read input directory: ${directory}`, { cause: error })
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

/** 扫描素材根目录：一级子目录且含角色子目录（服装/模特…）即为一组。 */
export async function scanSource(sourceRoot: string): Promise<ScannedGroup[]> {
  const { inputRoot, files } = await scanInput(sourceRoot)

  const groups = new Map<string, ScannedGroup>()
  for (const name of await listDirectories(inputRoot)) {
    if (RESERVED_GROUP_NAMES.has(name) || name.startsWith('.')) continue
    const children = await listDirectories(path.join(inputRoot, name))
    if (!children.some((child) => roleOfSegment(child) !== null)) continue
    const dir = name.normalize('NFC')
    groups.set(dir, { ...parseGroupDir(dir), dir, garments: [], models: [], stray: [] })
  }

  // scanInput 已按码位排序并跳过 成图/、._*、.DS_Store 等
  for (const file of files) {
    const segments = file.relativePath.split('/')
    const group = groups.get(segments[0]!)
    if (group === undefined) continue
    const role = segments.length > 2 ? roleOfSegment(segments[1]!) : null
    if (role === 'garment') group.garments.push(file)
    else if (role === 'model') group.models.push(file)
    else group.stray.push(file.relativePath)
  }

  return [...groups.values()].sort((left, right) => compareCodePoints(left.dir, right.dir))
}

/** 按搭配模式把组内素材配对成任务；数量不符时返回 incompleteReason 且不生成任务。 */
export function buildTasks(
  group: Group,
  garments: Asset[],
  models: Asset[],
  mode: PairingMode,
): { tasks: TaskSeed[]; incompleteReason?: string } {
  if (garments.length === 0) return { tasks: [], incompleteReason: '缺少服装图' }
  if (models.length === 0) return { tasks: [], incompleteReason: '缺少模特图' }
  if (mode === 'pair' && garments.length !== models.length) {
    return {
      tasks: [],
      incompleteReason:
        `一对一：服装 ${String(garments.length)} 张 · 模特 ${String(models.length)} 张，数量不一致`,
    }
  }

  const pairs: [Asset, Asset][] =
    mode === 'fixedClothing'
      ? models.map((model) => [garments[0]!, model])
      : mode === 'fixedModel'
        ? garments.map((garment) => [garment, models[0]!])
        : garments.map((garment, index) => [garment, models[index]!])

  const tasks: TaskSeed[] = []
  const seen = new Set<string>()
  for (const [garment, model] of pairs) {
    const id = stableId('task', group.dir, garment.contentHash, model.contentHash, mode)
    // 组内内容完全相同的两张图会得到同一任务 ID，只保留一个
    if (seen.has(id)) continue
    seen.add(id)
    tasks.push({ id, garmentAssetId: garment.id, modelAssetId: model.id })
  }
  return { tasks }
}

function assetFor(file: ScannedFile, role: Asset['role']): Asset {
  return {
    id: stableId('asset', file.relativePath, file.contentHash),
    role,
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    mediaType: file.mediaType,
    warnings: [],
  }
}

/** 把一次扫描结果合并进批次状态（纯函数，返回新状态）。已有任务、版本与判断保持不变。 */
export function mergeScan(state: BatchState, scanned: ScannedGroup[]): BatchState {
  const next = structuredClone(state)
  const assetsById = new Map(next.assets.map((asset) => [asset.id, asset]))
  const tasksById = new Map(next.tasks.map((task) => [task.id, task]))
  let nextOrder = next.groups.reduce((max, group) => Math.max(max, group.order + 1), 0)

  for (const scannedGroup of scanned) {
    const groupId = stableId('group', scannedGroup.dir)
    let group = next.groups.find((candidate) => candidate.id === groupId)
    if (group === undefined) {
      group = {
        id: groupId,
        sku: scannedGroup.sku,
        name: scannedGroup.name,
        dir: scannedGroup.dir,
        order: nextOrder,
        started: false,
      }
      nextOrder += 1
      next.groups.push(group)
    }

    // 内容变化的文件得到新的素材 ID；旧素材留在状态里供已有任务引用
    const ensureAsset = (file: ScannedFile, role: Asset['role']): Asset => {
      const fresh = assetFor(file, role)
      const existing = assetsById.get(fresh.id)
      if (existing !== undefined) return existing
      assetsById.set(fresh.id, fresh)
      next.assets.push(fresh)
      return fresh
    }
    const garments = scannedGroup.garments.map((file) => ensureAsset(file, 'garment'))
    const models = scannedGroup.models.map((file) => ensureAsset(file, 'model'))

    const mode = group.mode ?? next.settings.mode

    // 模特图张数提示按最新扫描与生效模式重算，只提示不阻止；固定模特模式本来就只有 1 张模特图，不提示
    const outOfRange = mode !== 'fixedModel' && (models.length < MODEL_COUNT_MIN || models.length > MODEL_COUNT_MAX)
    for (const model of models) {
      model.warnings = model.warnings.filter((warning) => !MODEL_COUNT_WARNING.test(warning))
      if (outOfRange) model.warnings.push(modelCountWarning(models.length))
    }

    const built = buildTasks(group, garments, models, mode)
    if (built.incompleteReason === undefined) delete group.incompleteReason
    else group.incompleteReason = built.incompleteReason

    const currentIds = new Set(built.tasks.map((seed) => seed.id))
    for (const task of next.tasks) {
      if (task.groupId !== group.id) continue
      if (currentIds.has(task.id)) {
        // 源文件恢复原内容后，任务重新可调度
        if (task.error?.code === 'INPUT_CHANGED') delete task.error
      } else if (task.error?.code !== 'INPUT_CHANGED') {
        task.error = { code: 'INPUT_CHANGED', message: '素材已变化，此任务不再调度' }
      }
    }

    for (const seed of built.tasks) {
      if (tasksById.has(seed.id)) continue
      const task: Task = {
        ...seed,
        groupId: group.id,
        status: 'queued',
        versions: [],
        excluded: false,
        pending: [],
      }
      tasksById.set(task.id, task)
      next.tasks.push(task)
    }
  }

  return next
}
