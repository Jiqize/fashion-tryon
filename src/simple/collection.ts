import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { RunnerError } from '../errors.js'
import type { SimpleGroup } from './layout.js'

// 合集设置：每款的搭配规则、保持画幅、半身标记、组顺序、裁图来源、待重出清单
// 只写 成图/_runs/collection.json，不写进素材文件夹

export type PairingRule = 'fixedGarment' | 'fixedModel' | 'oneToOne'

export interface GroupPrefs {
  pairing: PairingRule
  keepFrame: boolean
  /** 标了「半身」的模特图，相对素材根目录 */
  halfModels: string[]
}

export interface RedoItem {
  delivered: string
  runId: string
  sku: string
  model: string
  item?: string
  note?: string
}

export interface ItemOrder {
  garments?: string[]
  models?: string[]
  /** 裁图顺序：固定服装的默认参考图按这个顺序 */
  crops?: string[]
}

export interface CollectionState {
  version: 1
  order: string[]
  groups: Record<string, GroupPrefs>
  /** 每款衣服图、模特图、裁图的页面顺序（相对素材根目录）；没记的按文件名 */
  itemOrder: Record<string, ItemOrder>
  cropFrom: Record<string, string>
  redo: RedoItem[]
}

export const KEEP_FRAME_SENTENCE = '保持图1的取景范围，被截掉、没拍到的身体部位不要补画。'

export const PAIRING_LABELS: Record<PairingRule, string> = {
  fixedGarment: '固定服装',
  fixedModel: '固定模特',
  oneToOne: '一对一',
}

const groupPrefsSchema = z.object({
  pairing: z.enum(['fixedGarment', 'fixedModel', 'oneToOne']),
  keepFrame: z.boolean(),
  halfModels: z.array(z.string()),
})

const redoItemSchema = z.object({
  delivered: z.string(),
  runId: z.string(),
  sku: z.string(),
  model: z.string(),
  item: z.string().optional(),
  note: z.string().optional(),
})

const stateSchema = z.object({
  version: z.literal(1),
  order: z.array(z.string()),
  groups: z.record(z.string(), groupPrefsSchema),
  // 旧文件没有这个字段
  itemOrder: z.record(z.string(), z.object({ garments: z.array(z.string()).optional(), models: z.array(z.string()).optional(), crops: z.array(z.string()).optional() })).default({}),
  cropFrom: z.record(z.string(), z.string()),
  redo: z.array(redoItemSchema),
})

export function collectionPath(root: string): string {
  return path.join(root, '成图', '_runs', 'collection.json')
}

function defaultState(): CollectionState {
  return { version: 1, order: [], groups: {}, itemOrder: {}, cropFrom: {}, redo: [] }
}

function corrupt(root: string): RunnerError {
  const relative = path.relative(root, collectionPath(root)).split(path.sep).join('/')
  return new RunnerError('VALIDATION_ERROR', `合集设置文件损坏：${relative}`)
}

export async function readCollection(root: string): Promise<CollectionState> {
  let text: string
  try {
    text = await readFile(collectionPath(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultState()
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw corrupt(root)
  }
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) throw corrupt(root)
  return parsed.data as CollectionState
}

async function writeCollection(root: string, state: CollectionState): Promise<void> {
  const filePath = collectionPath(root)
  await mkdir(path.dirname(filePath), { recursive: true })
  // 先写同目录临时文件再 rename，中途失败不会留下写了一半的设置
  const temporary = `${filePath}.tmp-${String(process.pid)}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

// 同进程内按文件串行：后一次更新读到前一次的结果
const queues = new Map<string, Promise<unknown>>()

export async function updateCollection(
  root: string,
  mutate: (state: CollectionState) => void,
): Promise<CollectionState> {
  const key = path.resolve(collectionPath(root))
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const state = await readCollection(root)
    mutate(state)
    await writeCollection(root, state)
    return state
  })
  queues.set(key, next)
  try {
    return await next
  } finally {
    if (queues.get(key) === next) queues.delete(key)
  }
}

export function groupPrefs(state: CollectionState, sku: string): GroupPrefs {
  return state.groups[sku] ?? { pairing: 'fixedGarment', keepFrame: false, halfModels: [] }
}

/** 按记下的顺序排列：记过的在前（按记录顺序），其余保持原顺序排在后面。 */
export function orderFiles<T>(items: T[], order: string[] | undefined, key: (item: T) => string): T[] {
  if (order === undefined || order.length === 0) return items
  const rank = new Map(order.map((file, index) => [file, index]))
  const known = items.filter((item) => rank.has(key(item))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!)
  return [...known, ...items.filter((item) => !rank.has(key(item)))]
}

/** 一款的衣服图、模特图按页面上拖过的顺序排列。 */
export function orderedGroup(state: CollectionState, group: SimpleGroup): SimpleGroup {
  const order = state.itemOrder[group.sku]
  if (order === undefined) return group
  return {
    ...group,
    garments: orderFiles(group.garments, order.garments, (file) => file.relativePath),
    models: orderFiles(group.models, order.models, (file) => file.relativePath),
  }
}
