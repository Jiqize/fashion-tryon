import { z } from 'zod'

import { bboxSchema, imageSizes, plannedCropBoxSchema, scopes } from '../contracts.js'

export type { Bbox, ImageSize, Scope } from '../contracts.js'

export const pairingModes = ['fixedClothing', 'pair', 'fixedModel'] as const
export type PairingMode = (typeof pairingModes)[number]

export const regenTags = [
  'color',
  'extra_item',
  'missing_item',
  'outside_changed',
  'pose_changed',
  'person_changed',
  'role_swap',
  'other',
] as const
export type RegenTag = (typeof regenTags)[number]

const idSchema = z.string().trim().min(1)
// 状态中只允许相对路径（相对批次目录或素材根目录）
const relativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value),
  'path must be relative',
)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'expected SHA-256 hex digest')
const isoSchema = z.string().min(1)

export const cropBoxSchema = plannedCropBoxSchema
export type CropBox = z.infer<typeof cropBoxSchema>

export const batchSettingsSchema = z.object({
  mode: z.enum(pairingModes),
  scope: z.enum(scopes),
  candidates: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  concurrency: z.number().int().min(1).max(10),
  size: z.enum(imageSizes),
  imageModel: z.string(),
}).strict()
export type BatchSettings = z.infer<typeof batchSettingsSchema>

export const assetSchema = z.object({
  id: idSchema,
  role: z.enum(['garment', 'model']),
  relativePath: relativePathSchema,
  contentHash: sha256Schema,
  mediaType: z.string().min(1),
  preparedRelativePath: relativePathSchema.optional(),
  preparedHash: sha256Schema.optional(),
  bbox: bboxSchema.optional(),
  cropOverride: cropBoxSchema.optional(),
  warnings: z.array(z.string()),
}).strict()
export type Asset = z.infer<typeof assetSchema>

const regenInfoSchema = z.object({
  tags: z.array(z.enum(regenTags)),
  note: z.string().optional(),
  fromVersionId: idSchema,
}).strict()

export const versionSchema = z.object({
  id: idSchema,
  relativePath: relativePathSchema,
  sha256: sha256Schema,
  mediaType: z.string().min(1),
  createdAt: isoSchema,
  prompt: z.string(),
  regen: regenInfoSchema.optional(),
}).strict()
export type Version = z.infer<typeof versionSchema>

export const pendingJobSchema = z.object({
  jobId: idSchema,
  kind: z.enum(['first', 'regen']),
  prompt: z.string().optional(),
  regen: regenInfoSchema.optional(),
  providerRequestId: z.string().min(1).optional(),
  submittedAt: isoSchema.optional(),
}).strict()
export type PendingJob = z.infer<typeof pendingJobSchema>

export const taskSchema = z.object({
  id: idSchema,
  groupId: idSchema,
  garmentAssetId: idSchema,
  modelAssetId: idSchema,
  status: z.enum(['queued', 'running', 'done', 'failed']),
  versions: z.array(versionSchema),
  chosenVersionId: idSchema.optional(),
  excluded: z.boolean(),
  pending: z.array(pendingJobSchema),
  error: z.object({ code: z.string().min(1), message: z.string() }).strict().optional(),
}).strict()
export type Task = z.infer<typeof taskSchema>

// 与 src/ports.ts 的 GarmentBrief 保持同形
const garmentBriefSchema = z.object({
  imageType: z.enum(['flat_lay', 'on_model', 'other']),
  garments: z.array(z.object({ part: z.string(), item: z.string() }).strict()),
  suggestedPrompt: z.string(),
  uncertainty: z.array(z.string()),
  bbox: bboxSchema.optional(),
}).strict()

export const groupSchema = z.object({
  id: idSchema,
  sku: z.string(),
  name: z.string(),
  dir: relativePathSchema,
  mode: z.enum(pairingModes).optional(),
  scope: z.enum(scopes).optional(),
  order: z.number().int().nonnegative(),
  incompleteReason: z.string().min(1).optional(),
  started: z.boolean(),
  delivered: z.object({ at: isoSchema, files: z.array(relativePathSchema) }).strict().optional(),
  brief: garmentBriefSchema.optional(),
  basePrompt: z.string().optional(),
  // 准备阶段（服装定位、裁切、描述）失败时记录，组状态为 failed
  error: z.object({ code: z.string().min(1), message: z.string() }).strict().optional(),
}).strict()
export type Group = z.infer<typeof groupSchema>

export const batchStateSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: idSchema,
  sourceRoot: relativePathSchema,
  createdAt: isoSchema,
  settings: batchSettingsSchema,
  groups: z.array(groupSchema),
  assets: z.array(assetSchema),
  tasks: z.array(taskSchema),
  generationCallsUsed: z.number().int().nonnegative(),
}).strict()
export type BatchState = z.infer<typeof batchStateSchema>

export type GroupStatus = 'incomplete' | 'idle' | 'queued' | 'generating' | 'review' | 'delivered' | 'failed'

export function groupStatus(state: BatchState, groupId: string): GroupStatus {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) throw new Error(`Unknown group: ${groupId}`)
  if (group.incompleteReason !== undefined) return 'incomplete'
  if (group.delivered !== undefined) return 'delivered'
  if (group.error !== undefined) return 'failed'
  if (!group.started) return 'idle'
  const tasks = state.tasks.filter((task) => task.groupId === groupId)
  // 排队中的任务本身就带着待派发的 PendingJob，所以"全部排队"要先于"有 pending"判断，否则 queued 永远不可达
  if (tasks.every((task) => task.status === 'queued')) return 'queued'
  if (tasks.some((task) => task.status === 'running' || task.pending.length > 0)) return 'generating'
  // 已标记不交付的失败图视为已处理，不再让整套停在失败
  if (tasks.some((task) => task.status === 'failed' && !task.excluded)) return 'failed'
  if (tasks.every((task) => task.status === 'done' || (task.status === 'failed' && task.excluded))) return 'review'
  // 部分已完成、部分仍在排队：整套仍处于生成过程中
  return 'generating'
}

export interface BatchCounts {
  delivered: number
  review: number
  generating: number
  queued: number
  incomplete: number
  /** 失败且未标记不交付的任务张数（页面显示"失败 d 张"） */
  failed: number
  tasks: number
  /** 已用生成次数 */
  generationCalls: number
}

export function batchCounts(state: BatchState): BatchCounts {
  const counts: BatchCounts = {
    delivered: 0,
    review: 0,
    generating: 0,
    queued: 0,
    incomplete: 0,
    failed: state.tasks.filter((task) => task.status === 'failed' && !task.excluded).length,
    tasks: state.tasks.length,
    generationCalls: state.generationCallsUsed,
  }
  for (const group of state.groups) {
    const status = groupStatus(state, group.id)
    if (status === 'idle' || status === 'failed') continue
    counts[status] += 1
  }
  return counts
}
