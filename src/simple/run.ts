import { constants } from 'node:fs'
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { RunnerError, redactSecrets } from '../errors.js'
import type { ScannedFile } from '../studio/fs-scan.js'
import { groupPrefs, orderedGroup, readCollection, type GroupPrefs } from './collection.js'
import { CROP_DIR, listCrops } from './crop.js'
import { defaultGroupSettings } from './defaults.js'
import type { SimpleGenerator } from './generators.js'
import { scanSimple } from './layout.js'
import { acquireRunLock, releaseRunLock } from './lock.js'
import { writeGraphFiles } from './graph.js'
import { defaultItemRef, expandPairing } from './pairing.js'
import type { SwapMode } from './prompt.js'
import { countShots, newRunId, RUN_ID_PATTERN, runsDir, writeRunRecord, type RunGroup, type RunRecord } from './record.js'
import { renderSimpleReport } from './report.js'
import { deliveryStem, type PlannedGroup } from './rerun.js'

// 精简流程：扫描 → 写出完整计划 → 每张模特照出一张图（同款全部服装图作参考）→ 写进 成图/<款号>/ → 出一页报告
// 不做配对确认、不调用视觉模型、不做质检；已有文件从不覆盖；同一素材根目录同时只跑一个

export const DEFAULT_MAX_REFERENCES = 6
const PREPARED_EDGE = 1024

export interface SimpleRunOptions {
  sourceRoot: string
  generator: SimpleGenerator
  maxReferences?: number
  /** 默认 outfit（换整套） */
  swap?: SwapMode
  /** 只跑这些款号；不给则跑全部 */
  skus?: string[]
  /** 不给则按当前时间生成 YYYYMMDD-HHMMSS */
  runId?: string
  /** 心跳间隔，默认 15 秒；节点图靠它判断是否已中断 */
  heartbeatMs?: number
  /** 每次保存 run.json 与报告之后调用（节点图） */
  onSave?: (record: RunRecord) => Promise<void>
  /** 重出：按给定计划建组，不扫描、不读 裁图/；swap 与 skus 取自计划 */
  planned?: PlannedGroup[]
  /** 重出的来源 runId；页面新建出图没有 */
  derivedFrom?: string
  signal?: AbortSignal
  now?: () => Date
  onProgress?: (line: string) => void
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 成图/<款号>/<stem>.png（stem 见 deliveryStem）；同名已存在时依次试 -v2、-v3…，从不覆盖。 */
async function freeTarget(dir: string, stem: string): Promise<string> {
  for (let version = 1; ; version += 1) {
    const candidate = path.join(dir, version === 1 ? `${stem}.png` : `${stem}-v${String(version)}.png`)
    if (!(await exists(candidate))) return candidate
  }
}

function isDefaultPrefs(prefs: GroupPrefs): boolean {
  return prefs.pairing === 'fixedGarment' && !prefs.keepFrame && prefs.halfModels.length === 0
}

/** 计划里的一组 → 运行记录的组；带 item 的组按同款出现顺序编号 n，缩略图与生成文件放在 n 下。 */
function plannedToRunGroup(group: PlannedGroup, comboIndex: number | undefined): RunGroup {
  const dir = comboIndex === undefined ? `ref/${group.sku}` : `ref/${group.sku}/${String(comboIndex)}`
  const entry: RunGroup = {
    sku: group.sku,
    referenceSource: group.referenceSource ?? 'custom',
    swap: group.swap,
    promptEdited: group.promptEdited,
    references: group.references.map((ref, index) => ({
      file: ref.file,
      thumb: `${dir}/g${String(index + 1)}.jpg`,
      ...(ref.role === undefined ? {} : { role: ref.role }),
    })),
    prompt: group.prompt,
    shots: group.models.map((model, index) => ({
      model,
      modelThumb: `${dir}/m${String(index + 1)}.jpg`,
      state: 'queued' as const,
      ...(group.extraPrompts?.[model] === undefined ? {} : { extraPrompt: group.extraPrompts[model] }),
    })),
  }
  if (group.pairing !== undefined) entry.pairing = group.pairing
  if (group.item !== undefined) entry.item = group.item
  if (group.keepFrame === true) entry.keepFrame = true
  return entry
}

/**
 * 组在同款里的序号（从 1 起）：该款第一个无 item 的组路径不变，返回 undefined；
 * 带 item 的组与第二个起的无 item 组（如待重出跨 run 收集）按出现顺序编号，路径互不冲突。
 */
function comboIndexOf(groups: { sku: string; item?: string }[], position: number): number | undefined {
  const group = groups[position]!
  const sameSku = groups.slice(0, position + 1).filter((other) => other.sku === group.sku)
  const firstPlain = sameSku.findIndex((other) => other.item === undefined)
  if (group.item === undefined && firstPlain === sameSku.length - 1) return undefined
  return sameSku.length - (firstPlain === -1 ? 0 : 1)
}

async function prepare(source: string, target: string): Promise<void> {
  await sharp(source)
    .rotate()
    .resize(PREPARED_EDGE, PREPARED_EDGE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toFile(target)
}

export async function runSimple(options: SimpleRunOptions): Promise<RunRecord> {
  const root = path.resolve(options.sourceRoot)
  const signal = options.signal ?? new AbortController().signal
  const maxReferences = options.maxReferences ?? DEFAULT_MAX_REFERENCES
  const planned = options.planned
  const swap = planned?.[0]?.swap ?? options.swap ?? 'outfit'
  const now = options.now ?? (() => new Date())
  const log = options.onProgress ?? (() => undefined)

  // 先校验，出错时不建目录、不取锁
  const all = planned === undefined ? await scanSimple(root) : []
  if (planned === undefined && all.length === 0) {
    throw new RunnerError('VALIDATION_ERROR', `没有找到 服装/模特 目录：${root}`)
  }
  if (planned !== undefined && planned.length === 0) throw new RunnerError('VALIDATION_ERROR', '没有勾选要重出的图')
  // 同款可有多个出图组合，款号去重
  const wanted = planned === undefined ? options.skus : [...new Set(planned.map((group) => group.sku))]
  const missing = planned !== undefined ? [] : (wanted ?? []).filter((sku) => !all.some((group) => group.sku === sku))
  if (missing.length > 0) {
    throw new RunnerError('VALIDATION_ERROR', `找不到款号：${missing.join('、')}`)
  }
  const scanned = planned !== undefined ? [] : wanted === undefined ? all : all.filter((group) => wanted.includes(group.sku))
  const runId = options.runId ?? newRunId(now())
  if (!RUN_ID_PATTERN.test(runId)) throw new RunnerError('VALIDATION_ERROR', `runId 格式不对：${runId}`)

  // 合集设置也在取锁前读：文件损坏时不留空的 run 目录
  const collection = scanned.length > 0 ? await readCollection(root) : undefined

  await acquireRunLock(root, { runId, pid: process.pid, startedAt: now().toISOString() })
  let heartbeat: NodeJS.Timeout | undefined
  try {
    const runDir = path.join(runsDir(root), runId)
    // 目录可以预先存在（MCP 先放 run.log），但不能已有运行记录
    if (await exists(path.join(runDir, 'run.json'))) {
      throw new RunnerError('VALIDATION_ERROR', `run 已存在：${runId}`)
    }
    await mkdir(path.join(runDir, 'out'), { recursive: true })

    // 一次写出完整计划：所有款、所有单张都在，状态为排队
    type SourceFile = Pick<ScannedFile, 'sourcePath' | 'relativePath'>
    const plan: { group: RunGroup; referenceFiles: SourceFile[]; modelFiles: SourceFile[] }[] = []
    const sourceFile = (relativePath: string): SourceFile => ({ sourcePath: path.join(root, relativePath), relativePath })
    // 重出：参考图、提示词、模特图都照计划
    for (const [position, group] of (planned ?? []).entries()) {
      plan.push({
        group: plannedToRunGroup(group, comboIndexOf(planned!, position)),
        referenceFiles: group.references.map((ref) => sourceFile(ref.file)),
        modelFiles: group.models.map(sourceFile),
      })
    }
    // 扫描分支：设置过搭配规则、保持画幅或半身的款按合集设置展开
    const combos: PlannedGroup[] = []
    for (const scannedGroup of scanned) {
      // 按页面上拖过的衣服、模特顺序（一对一按这个顺序配对）
      const group = orderedGroup(collection!, scannedGroup)
      const defaults = await defaultGroupSettings(root, group, maxReferences, swap)
      const prefs = groupPrefs(collection!, group.sku)
      if (!isDefaultPrefs(prefs) && defaults.references.length > 0) {
        // 服装原图、模特图用磁盘原始路径打开
        const onDisk = new Map([...group.garments, ...group.models].map((file) => [file.relativePath, file]))
        const diskFile = (relativePath: string): SourceFile => onDisk.get(relativePath) ?? sourceFile(relativePath)
        const crops = (await listCrops(root, group.sku)).map((file) => `${CROP_DIR}/${group.sku}/${path.basename(file)}`.normalize('NFC'))
        const garments = group.garments.map((file) => file.relativePath)
        const itemRefs = Object.fromEntries(garments.map((garment) => [garment, defaultItemRef(garment, crops, collection!.cropFrom)]))
        let lanes
        try {
          lanes = expandPairing({
            sku: group.sku,
            pairing: prefs.pairing,
            garments,
            models: group.models.map((file) => file.relativePath),
            references: defaults.references,
            itemRefs,
            swap,
            keepFrame: prefs.keepFrame,
            halfModels: prefs.halfModels,
          }).lanes
        } catch (error) {
          if (!(error instanceof RunnerError)) throw error
          // 这款的设置不能出图（如固定模特有多个模特）：记为跳过，不影响其它款
          plan.push({
            group: { sku: group.sku, referenceSource: defaults.referenceSource, swap, promptEdited: false, references: [], prompt: defaults.prompt, shots: [], note: error.message },
            referenceFiles: [],
            modelFiles: [],
          })
          continue
        }
        for (const lane of lanes) {
          const combo: PlannedGroup = {
            sku: group.sku,
            referenceSource: lane.item === undefined ? defaults.referenceSource : lane.references[0]!.file.startsWith(`${CROP_DIR}/`) ? 'crops' : 'originals',
            swap,
            references: lane.references,
            prompt: lane.prompt,
            promptEdited: false,
            models: lane.models,
            ...(lane.item === undefined ? {} : { pairing: prefs.pairing, item: lane.item }),
            ...(lane.keepFrame ? { keepFrame: true } : {}),
            ...(Object.keys(lane.extraPrompts).length === 0 ? {} : { extraPrompts: lane.extraPrompts }),
          }
          combos.push(combo)
          const entry = plannedToRunGroup(combo, comboIndexOf(combos, combos.length - 1))
          if (lane.item === undefined && defaults.note !== undefined) entry.note = defaults.note
          plan.push({ group: entry, referenceFiles: combo.references.map((ref) => diskFile(ref.file)), modelFiles: combo.models.map(diskFile) })
        }
        continue
      }
      const entry: RunGroup = {
        sku: group.sku,
        referenceSource: defaults.referenceSource,
        swap,
        promptEdited: false,
        references: [],
        prompt: defaults.prompt,
        shots: [],
      }
      if (defaults.note !== undefined) entry.note = defaults.note
      if (defaults.references.length === 0) {
        plan.push({ group: entry, referenceFiles: [], modelFiles: [] })
        continue
      }
      // 服装原图用磁盘原始路径打开，裁图直接拼在根目录下
      const originals = new Map(group.garments.map((file) => [file.relativePath, file.sourcePath]))
      const referenceFiles = defaults.references.map((ref) => ({ sourcePath: originals.get(ref.file) ?? path.join(root, ref.file), relativePath: ref.file }))
      entry.references = defaults.references.map((ref, index) => ({
        file: ref.file,
        thumb: `ref/${group.sku}/g${String(index + 1)}.jpg`,
        ...(ref.role === undefined ? {} : { role: ref.role }),
      }))
      entry.shots = group.models.map((file, index) => ({
        model: file.relativePath,
        modelThumb: `ref/${group.sku}/m${String(index + 1)}.jpg`,
        state: 'queued' as const,
      }))
      plan.push({ group: entry, referenceFiles, modelFiles: group.models })
    }

    const groups = plan.map((item) => item.group)
    const record: RunRecord = {
      schemaVersion: 2,
      runId,
      sourceRoot: root,
      runDir,
      reportPath: path.join(runDir, 'report.html'),
      graphPath: path.join(runDir, 'graph.html'),
      engine: options.generator.name,
      params: { swap, skus: wanted ?? null, maxReferences, engine: options.generator.name },
      status: 'running',
      pid: process.pid,
      startedAt: now().toISOString(),
      finishedAt: null,
      heartbeatAt: now().toISOString(),
      current: null,
      derivedFrom: options.derivedFrom ?? null,
      groups,
      counts: countShots(groups),
    }
    // 保存串行进行，心跳与状态变化不会交错写
    let saving = Promise.resolve()
    const save = (): Promise<void> => {
      // 上一次保存失败不拖累后面的保存
      saving = saving.catch(() => undefined).then(async () => {
        record.counts = countShots(record.groups)
        await writeRunRecord(record)
        await writeFile(record.reportPath, renderSimpleReport(record, root))
        await (options.onSave ?? writeGraphFiles)(record)
      })
      return saving
    }
    await save()
    heartbeat = setInterval(() => {
      record.heartbeatAt = now().toISOString()
      void save().catch(() => undefined)
    }, options.heartbeatMs ?? 15_000)

    for (const { group } of plan) {
      if (group.shots.length === 0) log(`${group.sku}: ${group.note ?? ''}`)
    }
    // 参考图与模特图缩略图先全部准备好，节点图一开始就能看到所有图
    for (const [position, { group, referenceFiles, modelFiles }] of plan.entries()) {
      if (group.shots.length === 0) continue
      await mkdir(path.join(runDir, path.dirname(group.shots[0]!.modelThumb)), { recursive: true })
      for (const [index, file] of referenceFiles.entries()) {
        await prepare(file.sourcePath, path.join(runDir, group.references[index]!.thumb))
      }
      for (const [index, file] of modelFiles.entries()) {
        await prepare(file.sourcePath, path.join(runDir, group.shots[index]!.modelThumb))
      }
      // 提示词文件只写组提示词，不含每张的追加句
      const combo = comboIndexOf(plan.map((entry) => entry.group), position)
      await writeFile(path.join(runDir, `prompt-${group.sku}${combo === undefined ? '' : `-${String(combo)}`}.txt`), `${group.prompt}\n`)
    }
    await save()

    for (const [position, { group }] of plan.entries()) {
      const referencePaths = group.references.map((ref) => path.join(runDir, ref.thumb))
      const combo = comboIndexOf(plan.map((entry) => entry.group), position)
      for (const [index, shot] of group.shots.entries()) {
        if (signal.aborted) break
        shot.state = 'generating'
        record.current = { sku: group.sku, model: shot.model }
        await save()
        const outRelative = `out/${group.sku}${combo === undefined ? '' : `-${String(combo)}`}-m${String(index + 1)}.png`
        try {
          await options.generator.generate({
            modelPath: path.join(runDir, shot.modelThumb),
            referencePaths,
            prompt: shot.extraPrompt === undefined ? group.prompt : `${group.prompt}\n${shot.extraPrompt}`,
            outPath: path.join(runDir, outRelative),
          }, signal)
          // 取消时正在出的那张放弃，不写入 成图/
          if (signal.aborted) break
          const deliverDir = path.join(root, '成图', group.sku)
          await mkdir(deliverDir, { recursive: true })
          const target = await freeTarget(deliverDir, deliveryStem(shot.model, group.item))
          // COPYFILE_EXCL：目标在检查后被别人写入时也不覆盖
          await copyFile(path.join(runDir, outRelative), target, constants.COPYFILE_EXCL)
          shot.state = 'done'
          shot.result = outRelative
          shot.delivered = path.relative(root, target).split(path.sep).join('/')
          log(`OK ${group.sku} ${path.basename(shot.model)} → ${shot.delivered}`)
        } catch (error) {
          if (signal.aborted) break
          shot.state = 'failed'
          shot.error = redactSecrets(error instanceof Error ? error.message : String(error))
          log(`FAIL ${group.sku} ${path.basename(shot.model)}: ${shot.error}`)
        }
        record.current = null
        await save()
      }
      if (signal.aborted) break
    }

    clearInterval(heartbeat)
    heartbeat = undefined
    if (signal.aborted) {
      for (const group of record.groups) {
        for (const shot of group.shots) {
          if (shot.state === 'queued' || shot.state === 'generating') shot.state = 'cancelled'
        }
      }
      record.status = 'cancelled'
      log('已取消')
    } else {
      record.status = record.groups.some((group) => group.shots.some((shot) => shot.state === 'failed')) ? 'partial' : 'completed'
    }
    record.current = null
    record.finishedAt = now().toISOString()
    await save()
    return record
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    await releaseRunLock(root, runId)
  }
}
