import { randomUUID } from 'node:crypto'
import { open, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'
import type { PairingRule } from './collection.js'
import { isProcessAlive } from './lock.js'
import type { SwapMode } from './prompt.js'

// 精简流程的运行记录 run.json（v2）：开始出图时写入全部计划，每张状态变化后原子写盘
// 读取时把 v2 之前的旧格式归一成 v2，缺失字段留 null

export type ShotState = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled'
export type RunStatus = 'running' | 'completed' | 'partial' | 'cancelled' | 'interrupted'

export interface RunParams {
  swap: SwapMode
  skus: string[] | null
  maxReferences: number
  engine: string
}

export interface RunShot {
  model: string
  /** 相对 runDir */
  modelThumb: string
  state: ShotState
  /** 相对 runDir */
  result?: string
  /** 相对素材根目录 */
  delivered?: string
  error?: string
  /** 只追加给这一张的提示词（半身、待重出备注），生成时接在组提示词后面 */
  extraPrompt?: string
}

export interface RunGroup {
  sku: string
  /** custom：重出时人工指定的参考图 */
  referenceSource: 'crops' | 'originals' | 'custom'
  swap: SwapMode
  /** 提示词是否经人工修改（与默认生成的不同） */
  promptEdited: boolean
  references: { file: string; thumb: string; role?: string }[]
  prompt: string
  shots: RunShot[]
  note?: string
  /** 固定服装不写；固定模特、一对一才有 */
  pairing?: PairingRule
  /** 这个出图组合的衣服图（相对素材根目录）；固定服装没有 */
  item?: string
  /** 只在为真时写 */
  keepFrame?: boolean
}

export interface RunCounts {
  planned: number
  queued: number
  generating: number
  delivered: number
  failed: number
  cancelled: number
  skippedGroups: number
}

export interface RunRecord {
  schemaVersion: 2
  runId: string
  sourceRoot: string
  runDir: string
  reportPath: string
  graphPath: string
  engine: string
  params: RunParams | null
  status: Exclude<RunStatus, 'interrupted'>
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  heartbeatAt: string | null
  current: { sku: string; model: string } | null
  /** 重出时的来源 runId；普通出图为 null */
  derivedFrom: string | null
  groups: RunGroup[]
  counts: RunCounts
}

export const RUN_ID_PATTERN = /^\d{8}-\d{6}$/

/** 本地时间 YYYYMMDD-HHMMSS */
export function newRunId(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function runsDir(sourceRoot: string): string {
  return path.join(sourceRoot, '成图', '_runs')
}

export function countShots(groups: RunGroup[]): RunCounts {
  const counts: RunCounts = { planned: 0, queued: 0, generating: 0, delivered: 0, failed: 0, cancelled: 0, skippedGroups: 0 }
  for (const group of groups) {
    if (group.shots.length === 0 && group.note !== undefined) counts.skippedGroups += 1
    for (const shot of group.shots) {
      counts.planned += 1
      if (shot.state === 'queued') counts.queued += 1
      else if (shot.state === 'generating') counts.generating += 1
      else if (shot.state === 'done') counts.delivered += 1
      else if (shot.state === 'failed') counts.failed += 1
      else counts.cancelled += 1
    }
  }
  return counts
}

async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r').catch(() => undefined)
  if (handle === undefined) return
  await handle.sync().catch(() => undefined)
  await handle.close()
}

export async function writeRunRecord(record: RunRecord): Promise<void> {
  const filePath = path.join(record.runDir, 'run.json')
  const temporary = `${filePath}.tmp-${String(process.pid)}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
    await fsyncDirectory(record.runDir)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

interface LegacyShot {
  model: string
  modelThumb: string
  result?: string
  delivered?: string
  error?: string
}

interface LegacyRecord {
  runDir?: string
  reportPath?: string
  engine?: string
  groups?: (Omit<RunGroup, 'shots' | 'swap' | 'promptEdited'> & { shots: LegacyShot[] })[]
}

function normalizeLegacy(raw: LegacyRecord, runDir: string): RunRecord {
  const groups: RunGroup[] = (raw.groups ?? []).map((group) => ({
    ...group,
    swap: 'outfit',
    promptEdited: false,
    shots: group.shots.map((shot) => ({
      ...shot,
      state: shot.result !== undefined ? 'done' : shot.error !== undefined ? 'failed' : 'cancelled',
    })),
  }))
  const counts = countShots(groups)
  return {
    schemaVersion: 2,
    runId: path.basename(runDir),
    // runDir = <root>/成图/_runs/<runId>
    sourceRoot: path.dirname(path.dirname(path.dirname(runDir))),
    runDir,
    reportPath: path.join(runDir, 'report.html'),
    graphPath: path.join(runDir, 'graph.html'),
    engine: raw.engine ?? '',
    params: null,
    status: counts.failed > 0 ? 'partial' : 'completed',
    pid: null,
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    current: null,
    derivedFrom: null,
    groups,
    counts,
  }
}

export async function readRunRecord(runDir: string): Promise<RunRecord> {
  let text: string
  try {
    text = await readFile(path.join(runDir, 'run.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RunnerError('NOT_FOUND', `找不到运行记录：${runDir}`, { cause: error })
    }
    throw error
  }
  const raw = JSON.parse(text) as { schemaVersion?: number }
  if (raw.schemaVersion !== 2) return normalizeLegacy(raw as LegacyRecord, runDir)
  // 计数按逐张状态重算，旧的 v2 记录也能补上 generating
  // 早期 v2 记录没有 derivedFrom、每款 swap 和 promptEdited，按当时的行为补齐
  const record = raw as Partial<Pick<RunRecord, 'derivedFrom'>> & Omit<RunRecord, 'derivedFrom' | 'groups'> & {
    groups: (Omit<RunGroup, 'swap' | 'promptEdited'> & Partial<Pick<RunGroup, 'swap' | 'promptEdited'>>)[]
  }
  const groups: RunGroup[] = record.groups.map((group) => ({
    ...group,
    swap: group.swap ?? record.params?.swap ?? 'outfit',
    promptEdited: group.promptEdited ?? false,
  }))
  return { ...record, derivedFrom: record.derivedFrom ?? null, groups, counts: countShots(groups) }
}

/** 记录为进行中但进程已不在（或没有 pid）→ 已中断。 */
export function effectiveStatus(record: RunRecord, isAlive: (pid: number) => boolean = isProcessAlive): RunStatus {
  if (record.status !== 'running') return record.status
  return record.pid === null || !isAlive(record.pid) ? 'interrupted' : 'running'
}

/** 成图/_runs/ 下名字合法且 run.json 可解析的 run，按 runId 倒序；其余跳过。 */
export async function listRunRecords(sourceRoot: string): Promise<RunRecord[]> {
  const dir = runsDir(sourceRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: RunRecord[] = []
  for (const name of names.filter((entry) => RUN_ID_PATTERN.test(entry)).sort().reverse()) {
    try {
      records.push(await readRunRecord(path.join(dir, name)))
    } catch {
      // 没有 run.json 或内容损坏：不列出
    }
  }
  return records
}
