import path from 'node:path'

import { z } from 'zod'

import { RunnerError } from '../errors.js'
import { groupPrefs, KEEP_FRAME_SENTENCE, orderedGroup, readCollection, type PairingRule } from './collection.js'
import { CROP_DIR, listCrops } from './crop.js'
import { defaultGroupSettings } from './defaults.js'
import { scanSimple, type SimpleGroup } from './layout.js'
import { defaultItemRef, expandPairing } from './pairing.js'
import { buildPromptFromRoles, referenceRole, type SwapMode } from './prompt.js'
import { readRunRecord, RUN_ID_PATTERN, runsDir, type RunGroup, type RunRecord } from './record.js'

// 重出：从一个已有 run 里挑几张图，按每款的编辑（参考图、提示词、换装范围）生成新计划
// 节点图页面与 MCP rerun 都调这里，同样的输入得到同样的计划
// 页面新建出图（buildNewRunPlan）也产出同样格式的计划，只是没有来源 run

export interface RerunReference {
  /** 绝对路径或相对素材根目录 */
  file: string
  role?: string
}

export interface RerunGroupEdit {
  references?: RerunReference[]
  prompt?: string
  swap?: SwapMode
}

export interface RerunRequest {
  fromRunId: string
  /** item：固定模特 / 一对一的出图组合衣服图；不给匹配固定服装的组 */
  shots: { sku: string; model: string; item?: string }[]
  groups?: Record<string, RerunGroupEdit>
  engine?: 'codex' | 'apimart'
  maxReferences?: number
}

/** 页面新建出图里一款的选择；未给的字段用该款的合集设置。 */
export interface GroupSelection {
  models: string[]
  /** 固定模特 / 一对一下选中的衣服图；不给为全部 */
  garments?: string[]
  pairing?: PairingRule
  /** 固定服装的参考图 */
  references?: RerunReference[]
  /** 固定模特 / 一对一下每件衣服用的参考图 */
  itemRefs?: Record<string, string>
  prompt?: string
  swap?: SwapMode
  keepFrame?: boolean
}

/** 页面新建出图：从素材直接挑图，没有来源 run；顶层 swap / keepFrame 覆盖所有款。 */
export interface NewRunRequest {
  groups: Record<string, GroupSelection>
  engine?: 'codex' | 'apimart'
  maxReferences?: number
  swap?: SwapMode
  keepFrame?: boolean
}

/** 待重出清单一起重出。 */
export interface RedoRequest {
  items: { runId: string; sku: string; model: string; item?: string; note?: string }[]
  engine?: 'codex' | 'apimart'
}

export interface PlannedGroup {
  sku: string
  /** 不给按 custom 记录（重出） */
  referenceSource?: 'crops' | 'originals' | 'custom'
  swap: SwapMode
  /** 路径相对素材根目录，`/` 分隔 */
  references: { file: string; role?: string }[]
  prompt: string
  promptEdited: boolean
  models: string[]
  /** 以下只在固定模特 / 一对一、保持画幅、有追加提示词时写 */
  pairing?: PairingRule
  item?: string
  keepFrame?: boolean
  /** 模特图 → 只追加给这一张的提示词 */
  extraPrompts?: Record<string, string>
}

export interface RerunPlan {
  /** 新建出图没有来源 run */
  fromRunId?: string
  engine: 'codex' | 'apimart' | 'fake'
  maxReferences: number
  groups: PlannedGroup[]
}

const swapSchema = z.enum(['outfit', 'top'])
const referenceSchema = z.object({
  file: z.string().min(1),
  role: z.string().min(1).max(40).optional(),
})

const pairingSchema = z.enum(['fixedGarment', 'fixedModel', 'oneToOne'])
const engineSchema = z.enum(['codex', 'apimart'])
const maxReferencesSchema = z.number().int().min(1).max(10)

const requestSchema = z.object({
  fromRunId: z.string().regex(RUN_ID_PATTERN, 'runId 格式应为 YYYYMMDD-HHMMSS'),
  shots: z.array(z.object({ sku: z.string().min(1), model: z.string().min(1), item: z.string().min(1).optional() })),
  groups: z.record(z.string().min(1), z.object({
    references: z.array(referenceSchema).optional(),
    prompt: z.string().min(1).optional(),
    swap: swapSchema.optional(),
  })).optional(),
  engine: engineSchema.optional(),
  maxReferences: maxReferencesSchema.optional(),
})

const newRunSchema = z.object({
  groups: z.record(z.string().min(1), z.object({
    models: z.array(z.string().min(1)),
    garments: z.array(z.string().min(1)).optional(),
    pairing: pairingSchema.optional(),
    references: z.array(referenceSchema).optional(),
    itemRefs: z.record(z.string().min(1), z.string().min(1)).optional(),
    prompt: z.string().min(1).optional(),
    swap: swapSchema.optional(),
    keepFrame: z.boolean().optional(),
  })),
  engine: engineSchema.optional(),
  maxReferences: maxReferencesSchema.optional(),
  swap: swapSchema.optional(),
  keepFrame: z.boolean().optional(),
})

const redoSchema = z.object({
  items: z.array(z.object({
    runId: z.string().min(1),
    sku: z.string().min(1),
    model: z.string().min(1),
    item: z.string().min(1).optional(),
    note: z.string().optional(),
  })),
  engine: engineSchema.optional(),
})

const planSchema = z.object({
  fromRunId: z.string().regex(RUN_ID_PATTERN).optional(),
  engine: z.enum(['codex', 'apimart', 'fake']),
  maxReferences: z.number().int().min(1).max(10),
  groups: z.array(z.object({
    sku: z.string().min(1),
    referenceSource: z.enum(['crops', 'originals', 'custom']).optional(),
    swap: swapSchema,
    references: z.array(referenceSchema).min(1),
    prompt: z.string().min(1),
    promptEdited: z.boolean(),
    models: z.array(z.string().min(1)).min(1),
    pairing: pairingSchema.optional(),
    item: z.string().min(1).optional(),
    keepFrame: z.boolean().optional(),
    extraPrompts: z.record(z.string().min(1), z.string().min(1)).optional(),
  })).min(1),
})

function strip<T extends object>(value: T): T {
  // zod 会把未给的可选字段留成 undefined 键，去掉后计划可以直接逐字比较
  return JSON.parse(JSON.stringify(value)) as T
}

export function parseRerunRequest(value: unknown): RerunRequest {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RunnerError('VALIDATION_ERROR', `重出参数不对：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim())
  }
  return strip(parsed.data as RerunRequest)
}

export function parseNewRunRequest(value: unknown): NewRunRequest {
  const parsed = newRunSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RunnerError('VALIDATION_ERROR', `出图参数不对：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim())
  }
  return strip(parsed.data as NewRunRequest)
}

export function parseRedoRequest(value: unknown): RedoRequest {
  const parsed = redoSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RunnerError('VALIDATION_ERROR', `待重出参数不对：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim())
  }
  return strip(parsed.data as RedoRequest)
}

/** 交付文件名（不含扩展名与版本后缀）：有 item 时 `<衣服图名>-<模特图名>`，否则 `<模特图名>`。 */
export function deliveryStem(model: string, item?: string): string {
  const modelStem = path.parse(model).name
  return item === undefined ? modelStem : `${path.parse(item).name}-${modelStem}`
}

/** rerun 命令读的计划文件。 */
export function parseRerunPlan(value: unknown): RerunPlan {
  const parsed = planSchema.safeParse(value)
  if (!parsed.success) {
    throw new RunnerError('VALIDATION_ERROR', `重出计划格式不对：${parsed.error.issues[0]?.message ?? ''}`)
  }
  return strip(parsed.data as RerunPlan)
}

export function defaultPrompt(references: { file: string; role?: string }[], swap: SwapMode): string {
  return buildPromptFromRoles(references.map((ref) => ref.role ?? referenceRole(path.basename(ref.file))), swap)
}

export function currentSettings(_record: RunRecord, group: RunGroup): {
  swap: SwapMode
  references: { file: string; role?: string }[]
  prompt: string
  promptEdited: boolean
} {
  return {
    swap: group.swap,
    references: group.references.map((ref) => ({ file: ref.file, ...(ref.role === undefined ? {} : { role: ref.role }) })),
    prompt: group.prompt,
    promptEdited: group.promptEdited,
  }
}

/** 绝对路径或相对路径 → 相对素材根目录、`/` 分隔、NFC。 */
function relativeTo(root: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(root, file)
  return path.relative(root, absolute).split(path.sep).join('/').normalize('NFC')
}

/** 参考图只能是这款的服装原图或 裁图/<款号>/ 下现存的图，且不超过上限。 */
async function resolveReferences(
  root: string,
  group: SimpleGroup,
  refs: RerunReference[],
  maxReferences: number,
): Promise<{ file: string; role?: string }[]> {
  const sku = group.sku
  const crops = (await listCrops(root, sku)).map((file) => `${CROP_DIR}/${sku}/${path.basename(file)}`.normalize('NFC'))
  const allowed = new Set([...group.garments.map((file) => file.relativePath), ...crops])
  const references = refs.map((ref) => {
    const file = relativeTo(root, ref.file)
    if (!allowed.has(file)) throw new RunnerError('VALIDATION_ERROR', `${sku} 的参考图不可用：${ref.file}`)
    return { file, ...(ref.role === undefined ? {} : { role: ref.role }) }
  })
  if (references.length === 0) throw new RunnerError('VALIDATION_ERROR', `${sku} 没有参考图`)
  if (references.length > maxReferences) {
    throw new RunnerError('VALIDATION_ERROR', `参考图 ${String(references.length)} 张，超过上限 ${String(maxReferences)} 张`)
  }
  return references
}

function checkMaxReferences(maxReferences: number): void {
  if (!Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 10) {
    throw new RunnerError('VALIDATION_ERROR', `参考图上限应为 1–10：${String(maxReferences)}`)
  }
}

/** 选中的图（模特图或服装图）按扫描顺序去重；不在这款里时报错。 */
function pickFiles(root: string, sku: string, available: string[], picked: string[], kind: string): string[] {
  const wanted = new Set<string>()
  for (const file of picked) {
    const relative = relativeTo(root, file)
    if (!available.includes(relative)) throw new RunnerError('VALIDATION_ERROR', `${sku} 没有这张${kind}：${file}`)
    wanted.add(relative)
  }
  return available.filter((file) => wanted.has(file))
}

function defaultEngine(engine: 'codex' | 'apimart' | undefined, env: NodeJS.ProcessEnv): RerunPlan['engine'] {
  return engine ?? (env.FASHION_TRYON_FAKE_ENGINE !== undefined ? 'fake' : 'codex')
}

function withKeepFrame(prompt: string, keepFrame: boolean): string {
  return keepFrame ? `${prompt}\n${KEEP_FRAME_SENTENCE}` : prompt
}

/** 新字段只在有值时写，固定服装组的计划与原来逐字一致。 */
/** 当前标了半身的模特图：组提示词与追加句里都没有那句时，补到这一张。 */
function withHalfBody(extra: string, model: string, halfModels: string[], prompt: string): string {
  if (prompt.includes(KEEP_FRAME_SENTENCE) || !halfModels.includes(model) || extra.includes(KEEP_FRAME_SENTENCE)) return extra
  return extra === '' ? KEEP_FRAME_SENTENCE : `${KEEP_FRAME_SENTENCE}\n${extra}`
}

function comboFields(group: { pairing?: PairingRule; item?: string; keepFrame?: boolean }): Pick<PlannedGroup, 'pairing' | 'item' | 'keepFrame'> {
  return {
    ...(group.pairing === undefined || group.pairing === 'fixedGarment' ? {} : { pairing: group.pairing }),
    ...(group.item === undefined ? {} : { item: group.item }),
    ...(group.keepFrame === true ? { keepFrame: true } : {}),
  }
}

export async function buildRerunPlan(
  sourceRoot: string,
  request: RerunRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RerunPlan> {
  const root = path.resolve(sourceRoot)
  if (!RUN_ID_PATTERN.test(request.fromRunId)) {
    throw new RunnerError('VALIDATION_ERROR', `runId 格式不对：${request.fromRunId}`)
  }
  const source = await readRunRecord(path.join(runsDir(root), request.fromRunId))
  if (request.shots.length === 0) throw new RunnerError('VALIDATION_ERROR', '没有勾选要重出的图')
  const maxReferences = request.maxReferences ?? source.params?.maxReferences ?? 6
  checkMaxReferences(maxReferences)
  const scanned = new Map((await scanSimple(root)).map((group) => [group.sku, group]))
  const collection = await readCollection(root)

  // 每张按 款号 + item 找来源组：带 item 只配同 item 的组，不带只配无 item 的组
  const wanted = new Map<RunGroup, Set<string>>()
  for (const shot of request.shots) {
    if (!source.groups.some((group) => group.sku === shot.sku)) {
      throw new RunnerError('VALIDATION_ERROR', `来源 run 里没有这个款号：${shot.sku}`)
    }
    const model = relativeTo(root, shot.model)
    if (!(scanned.get(shot.sku)?.models.some((file) => file.relativePath === model) ?? false)) {
      throw new RunnerError('VALIDATION_ERROR', `${shot.sku} 没有这张模特图：${shot.model}`)
    }
    const item = shot.item === undefined ? undefined : relativeTo(root, shot.item)
    const sourceGroup = source.groups.find((group) => group.sku === shot.sku && group.item === item)
    if (sourceGroup === undefined) throw new RunnerError('VALIDATION_ERROR', `来源 run 里没有这张：${shot.sku} ${shot.model}`)
    const models = wanted.get(sourceGroup) ?? new Set<string>()
    models.add(model)
    wanted.set(sourceGroup, models)
  }

  const groups: PlannedGroup[] = []
  for (const sourceGroup of source.groups) {
    const models = wanted.get(sourceGroup)
    if (models === undefined) continue
    const sku = sourceGroup.sku
    const scannedGroup = scanned.get(sku)!
    const edit = request.groups?.[sku] ?? {}
    const sourceSettings = currentSettings(source, sourceGroup)
    const swap = edit.swap ?? sourceSettings.swap

    const references = await resolveReferences(root, scannedGroup, edit.references ?? sourceSettings.references, maxReferences)

    const fallback = withKeepFrame(defaultPrompt(references, swap), sourceGroup.keepFrame === true)
    const unchanged = swap === sourceSettings.swap && JSON.stringify(references) === JSON.stringify(sourceSettings.references)
    let prompt = fallback
    let promptEdited = false
    if (edit.prompt !== undefined) {
      prompt = edit.prompt
      promptEdited = edit.prompt !== fallback
    } else if (unchanged && sourceSettings.promptEdited) {
      // 来源 run 用的是人工提示词且设置没变：沿用
      prompt = sourceSettings.prompt
      promptEdited = true
    }

    // 款内按扫描顺序
    const ordered = scannedGroup.models.map((file) => file.relativePath).filter((file) => models.has(file))
    const extraPrompts: Record<string, string> = {}
    for (const model of ordered) {
      const extra = withHalfBody('', model, groupPrefs(collection, sku).halfModels, prompt)
      if (extra !== '') extraPrompts[model] = extra
    }
    groups.push({
      sku,
      swap,
      references,
      prompt,
      promptEdited,
      models: ordered,
      ...comboFields(sourceGroup),
      ...(Object.keys(extraPrompts).length === 0 ? {} : { extraPrompts }),
    })
  }

  return {
    fromRunId: request.fromRunId,
    engine: defaultEngine(request.engine, env),
    maxReferences,
    groups,
  }
}

/** 页面新建出图：每款按选择与合集设置展开成出图组合；固定服装且未编辑的款与 start_run 默认规则一致。 */
export async function buildNewRunPlan(
  sourceRoot: string,
  request: NewRunRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RerunPlan> {
  const root = path.resolve(sourceRoot)
  const selections = Object.entries(request.groups)
  if (selections.length === 0) throw new RunnerError('VALIDATION_ERROR', '没有勾选要出图的图')
  const maxReferences = request.maxReferences ?? 6
  checkMaxReferences(maxReferences)
  const scannedList = await scanSimple(root)
  for (const [sku] of selections) {
    if (!scannedList.some((group) => group.sku === sku)) throw new RunnerError('VALIDATION_ERROR', `找不到款号：${sku}`)
  }
  const state = await readCollection(root)

  const groups: PlannedGroup[] = []
  // 款按扫描顺序
  for (const scanned of scannedList) {
    const selection = request.groups[scanned.sku]
    if (selection === undefined) continue
    // 衣服、模特按页面上排过的顺序：一对一按这个顺序配对
    const scannedGroup = orderedGroup(state, scanned)
    const sku = scannedGroup.sku
    const prefs = groupPrefs(state, sku)
    const pairing = selection.pairing ?? prefs.pairing
    const swap = request.swap ?? selection.swap ?? 'outfit'
    const keepFrame = request.keepFrame ?? selection.keepFrame ?? prefs.keepFrame
    const originals = scannedGroup.garments.map((file) => file.relativePath)
    const models = pickFiles(root, sku, scannedGroup.models.map((file) => file.relativePath), selection.models, '模特图')
    const garments = selection.garments === undefined ? originals : pickFiles(root, sku, originals, selection.garments, '服装图')
    const edited = selection.references !== undefined || selection.prompt !== undefined || selection.swap !== undefined

    let references: { file: string; role?: string }[] = []
    let referenceSource: PlannedGroup['referenceSource'] = 'custom'
    const itemRefs: Record<string, string> = {}
    if (pairing === 'fixedGarment') {
      const defaults = await defaultGroupSettings(root, scannedGroup, maxReferences, swap)
      if (defaults.references.length === 0) throw new RunnerError('VALIDATION_ERROR', `${sku} 缺少服装图，不能出图`)
      references = selection.references === undefined
        ? defaults.references
        : await resolveReferences(root, scannedGroup, selection.references, maxReferences)
      if (!edited) referenceSource = defaults.referenceSource
    } else {
      // 每件衣服的参考图只能是它的原图或这款的裁图；没给的用默认裁图
      const crops = (await listCrops(root, sku)).map((file) => `${CROP_DIR}/${sku}/${path.basename(file)}`.normalize('NFC'))
      for (const [garment, file] of Object.entries(selection.itemRefs ?? {})) {
        const key = relativeTo(root, garment)
        const ref = relativeTo(root, file)
        if (ref !== key && !crops.includes(ref)) throw new RunnerError('VALIDATION_ERROR', `${sku} 的参考图不可用：${file}`)
        itemRefs[key] = ref
      }
      for (const garment of garments) itemRefs[garment] ??= defaultItemRef(garment, crops, state.cropFrom)
    }

    const { lanes } = expandPairing({
      sku, pairing, garments, models, references, itemRefs, swap, keepFrame,
      halfModels: prefs.halfModels,
      ...(selection.prompt === undefined ? {} : { prompt: selection.prompt }),
    })
    for (const lane of lanes) {
      // 默认提示词按参考图用途生成（与重出一致）；人工提示词与默认相同时不算改过
      const fallback = withKeepFrame(defaultPrompt(lane.references, swap), keepFrame)
      const prompt = selection.prompt === undefined ? fallback : lane.prompt
      const source = lane.item === undefined || edited || selection.itemRefs?.[lane.item] !== undefined
        ? referenceSource
        : lane.references[0]!.file.startsWith(`${CROP_DIR}/`) ? 'crops' : 'originals'
      groups.push({
        sku,
        referenceSource: source,
        swap,
        references: lane.references,
        prompt,
        promptEdited: prompt !== fallback,
        models: lane.models,
        ...comboFields({ pairing, ...(lane.item === undefined ? {} : { item: lane.item }), keepFrame }),
        ...(Object.keys(lane.extraPrompts).length === 0 ? {} : { extraPrompts: lane.extraPrompts }),
      })
    }
  }

  return { engine: defaultEngine(request.engine, env), maxReferences, groups }
}

/** 待重出：每项沿用来源组的参考图、提示词、范围与组合，备注作为这一张的追加提示词；同一来源组合并。 */
export async function buildRedoPlan(
  sourceRoot: string,
  request: RedoRequest,
  engineDefault: 'codex' | 'fake',
): Promise<RerunPlan> {
  const root = path.resolve(sourceRoot)
  if (request.items.length === 0) throw new RunnerError('VALIDATION_ERROR', '待重出是空的')
  const collection = await readCollection(root)
  // 来源图要还在磁盘上：被删掉的提前报错，不等到生成阶段
  const scanned = new Map((await scanSimple(root)).map((group) => [group.sku, group]))
  const available = new Map<string, Set<string>>()
  const availableOf = async (sku: string): Promise<Set<string>> => {
    let files = available.get(sku)
    if (files === undefined) {
      const group = scanned.get(sku)
      const crops = (await listCrops(root, sku)).map((file) => `${CROP_DIR}/${sku}/${path.basename(file)}`.normalize('NFC'))
      files = new Set([...(group?.garments ?? []).map((file) => file.relativePath), ...(group?.models ?? []).map((file) => file.relativePath), ...crops])
      available.set(sku, files)
    }
    return files
  }
  const records = new Map<string, RunRecord>()
  const merged = new Map<RunGroup, PlannedGroup>()
  const groups: PlannedGroup[] = []
  let maxReferences = 0

  for (const entry of request.items) {
    let record = records.get(entry.runId)
    if (record === undefined) {
      const notFound = new RunnerError('VALIDATION_ERROR', `找不到出图记录：${entry.runId}`)
      if (!RUN_ID_PATTERN.test(entry.runId)) throw notFound
      try {
        record = await readRunRecord(path.join(runsDir(root), entry.runId))
      } catch (error) {
        if (error instanceof RunnerError && error.code === 'NOT_FOUND') throw notFound
        throw error
      }
      records.set(entry.runId, record)
      maxReferences = Math.max(maxReferences, record.params?.maxReferences ?? 6)
    }
    const item = entry.item === undefined ? undefined : relativeTo(root, entry.item)
    const model = relativeTo(root, entry.model)
    const sourceGroup = record.groups.find((group) =>
      group.sku === entry.sku && group.item === item && group.shots.some((shot) => shot.model === model))
    if (sourceGroup === undefined) {
      throw new RunnerError('VALIDATION_ERROR', `${entry.runId} 里没有这张：${entry.sku} ${entry.model}`)
    }
    const files = await availableOf(sourceGroup.sku)
    if (!files.has(model)) throw new RunnerError('VALIDATION_ERROR', `${sourceGroup.sku} 没有这张模特图：${model}`)
    const gone = sourceGroup.references.find((ref) => !files.has(ref.file))
    if (gone !== undefined) throw new RunnerError('VALIDATION_ERROR', `${sourceGroup.sku} 的参考图不可用：${gone.file}`)
    let planned = merged.get(sourceGroup)
    if (planned === undefined) {
      planned = {
        sku: sourceGroup.sku,
        swap: sourceGroup.swap,
        references: sourceGroup.references.map((ref) => ({ file: ref.file, ...(ref.role === undefined ? {} : { role: ref.role }) })),
        prompt: sourceGroup.prompt,
        promptEdited: sourceGroup.promptEdited,
        models: [],
        ...comboFields(sourceGroup),
      }
      merged.set(sourceGroup, planned)
      groups.push(planned)
    }
    if (!planned.models.includes(model)) planned.models.push(model)
    const shot = sourceGroup.shots.find((candidate) => candidate.model === model)!
    const joined = [shot.extraPrompt, entry.note].filter((text): text is string => text !== undefined && text !== '').join('\n')
    const extra = withHalfBody(joined, model, groupPrefs(collection, sourceGroup.sku).halfModels, planned.prompt)
    if (extra !== '') planned.extraPrompts = { ...planned.extraPrompts, [model]: extra }
  }

  return { engine: request.engine ?? engineDefault, maxReferences: Math.min(maxReferences, 10), groups }
}
