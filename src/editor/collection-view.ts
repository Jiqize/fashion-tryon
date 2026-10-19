import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { groupPrefs, orderedGroup, readCollection, type GroupPrefs, type RedoItem } from '../simple/collection.js'
import { CROP_DIR, listCrops } from '../simple/crop.js'
import { defaultGroupSettings } from '../simple/defaults.js'
import { scanSimple } from '../simple/layout.js'
import { readActiveLock } from '../simple/lock.js'
import { listRunRecords, readRunRecord, runsDir, type RunRecord } from '../simple/record.js'

// 合集页数据：每款的图、合集设置、成图版本（含 Finder 手放）与进行中的出图

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VERSION_PATTERN = /^(.*)-v(\d+)$/

export interface OutputView {
  file: string
  item: string | null
  model: string | null
  /** 产出这张成图的那次出图里实际用的第一张参考图；手放或没有记录时为 null */
  ref: string | null
  /** 那次出图实际用的全部参考图（固定服装可能有多张）；手放或没有记录时为空 */
  refs: string[]
  version: number
  runId: string | null
}

export interface InFlightView {
  runId: string
  item: string | null
  model: string
  state: 'queued' | 'generating' | 'failed'
}

export interface GroupView {
  sku: string
  garments: string[]
  crops: string[]
  cropFrom: Record<string, string>
  models: string[]
  prefs: GroupPrefs
  defaults: { swap: 'outfit'; references: { file: string; role?: string }[]; prompt: string; referenceSource: 'crops' | 'originals' }
  outputs: OutputView[]
  inFlight: InFlightView[]
}

export interface CollectionView {
  rootName: string
  /** 项目页上的显示名；不在项目列表里时为文件夹名 */
  projectName: string
  latestRunId: string | null
  activeRun: { runId: string; done: number; total: number } | null
  maxReferences: 6
  engineDefault: 'codex' | 'fake'
  order: string[]
  redo: RedoItem[]
  groups: GroupView[]
}

type Delivered = Map<string, { item: string | null; ref: string | null; refs: string[]; model: string; runId: string }>

/** 所有运行记录里交付文件 → 产出它的组合；记录按新到旧，新的优先。 */
function deliveredIndex(records: RunRecord[]): Delivered {
  const delivered: Delivered = new Map()
  for (const record of records) {
    for (const group of record.groups) {
      for (const shot of group.shots) {
        const file = shot.delivered?.normalize('NFC')
        if (file !== undefined && !delivered.has(file)) {
          // 带 item 的组只有一张参考图，就是这件衣服实际用的图；固定服装取第一张参考图做对照
          const refs = group.references.map((reference) => reference.file)
          delivered.set(file, { item: group.item ?? null, ref: refs[0] ?? null, refs, model: shot.model, runId: record.runId })
        }
      }
    }
  }
  return delivered
}

/** 成图/<款号>/ 下的图：按去掉版本后缀的文件名分组，组内版本升序。 */
async function outputsOf(root: string, sku: string, delivered: Delivered): Promise<OutputView[]> {
  const names = await readdir(path.join(root, '成图', sku)).catch(() => [] as string[])
  return names
    .filter((name) => !name.startsWith('.') && IMAGE_EXTENSIONS.has(path.extname(name).toLocaleLowerCase('en-US')))
    .map((name) => {
      const stem = path.parse(name).name
      const match = VERSION_PATTERN.exec(stem)
      const file = `成图/${sku}/${name}`.normalize('NFC')
      const source = delivered.get(file)
      return {
        base: match === null ? stem : match[1]!,
        view: {
          file,
          item: source?.item ?? null,
          model: source?.model ?? null,
          ref: source?.ref ?? null,
          refs: source?.refs ?? [],
          version: match === null ? 1 : Number(match[2]),
          runId: source?.runId ?? null,
        },
      }
    })
    .sort((a, b) => a.base.localeCompare(b.base, 'zh-CN', { numeric: true }) || a.view.version - b.view.version)
    .map((entry) => entry.view)
}

export async function collectionView(root: string, engineDefault: 'codex' | 'fake', projectName = path.basename(root)): Promise<CollectionView> {
  const records = await listRunRecords(root)
  const [latest] = records
  const delivered = deliveredIndex(records)
  const state = await readCollection(root)
  const lock = await readActiveLock(root)
  // 锁已占但 run.json 还没写出时也算在跑
  const active = lock === null
    ? undefined
    : records.find((record) => record.runId === lock.runId)
      ?? await readRunRecord(path.join(runsDir(root), lock.runId)).catch(() => undefined)
  const activeShots = active?.groups.flatMap((group) => group.shots) ?? []
  // 进行中状态只看在跑的 run 与最近一次 run
  const watched = [active, latest].filter((record, index, list): record is RunRecord =>
    record !== undefined && list.findIndex((other) => other?.runId === record.runId) === index)

  return {
    rootName: path.basename(root),
    projectName,
    latestRunId: latest?.runId ?? null,
    activeRun: lock === null
      ? null
      : {
          runId: lock.runId,
          done: activeShots.filter((shot) => shot.state === 'done' || shot.state === 'failed' || shot.state === 'cancelled').length,
          total: active?.counts.planned ?? 0,
        },
    maxReferences: 6,
    engineDefault,
    order: state.order,
    redo: state.redo,
    groups: await Promise.all((await scanSimple(root)).map((scanned) => orderedGroup(state, scanned)).map(async (group) => {
      const defaults = await defaultGroupSettings(root, group, 6, 'outfit')
      const crops = (await listCrops(root, group.sku)).map((file) => `${CROP_DIR}/${group.sku}/${path.basename(file)}`)
      const inFlight: InFlightView[] = []
      for (const record of watched) {
        for (const runGroup of record.groups.filter((candidate) => candidate.sku === group.sku)) {
          for (const shot of runGroup.shots) {
            if (shot.state === 'queued' || shot.state === 'generating' || shot.state === 'failed') {
              inFlight.push({ runId: record.runId, item: runGroup.item ?? null, model: shot.model, state: shot.state })
            }
          }
        }
      }
      return {
        sku: group.sku,
        garments: group.garments.map((file) => file.relativePath),
        crops,
        cropFrom: Object.fromEntries(crops.filter((crop) => state.cropFrom[crop] !== undefined).map((crop) => [crop, state.cropFrom[crop]!])),
        models: group.models.map((file) => file.relativePath),
        prefs: groupPrefs(state, group.sku),
        defaults: { swap: 'outfit' as const, references: defaults.references, prompt: defaults.prompt, referenceSource: defaults.referenceSource },
        outputs: await outputsOf(root, group.sku, delivered),
        inFlight,
      }
    })),
  }
}
