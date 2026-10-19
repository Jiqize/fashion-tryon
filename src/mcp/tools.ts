import { stat } from 'node:fs/promises'
import path from 'node:path'

import { loadRunnerConfig, requireApimartConfig } from '../config.js'
import { RunnerError } from '../errors.js'
import { applyCropPlan, listCrops, parseCropPlan } from '../simple/crop.js'
import { scanSimple } from '../simple/layout.js'
import { readActiveLock } from '../simple/lock.js'
import {
  effectiveStatus,
  listRunRecords,
  readRunRecord,
  RUN_ID_PATTERN,
  runsDir,
  type RunCounts,
  type RunGroup,
  type RunParams,
  type RunRecord,
  type RunStatus,
  type ShotState,
} from '../simple/record.js'
import type { SwapMode } from '../simple/prompt.js'
import { buildNewRunPlan, buildRedoPlan, buildRerunPlan, parseNewRunRequest, parseRedoRequest, parseRerunRequest, type RerunRequest } from '../simple/rerun.js'
import { ensureEditor } from '../editor/launch.js'
import { editorMaterialsUrl, editorPageUrl } from '../editor/server.js'
import { launchRerun, launchRun, stopRun, type LaunchConfig, type StartRunInput } from './launch.js'

// MCP 六个工具的业务处理：不依赖 MCP SDK，可直接单测
// 返回的文件路径一律为绝对路径，宿主 Agent 可以直接打开图片

export type { LaunchConfig, StartRunInput } from './launch.js'

export interface ScanToolResult {
  sourceRoot: string
  groups: { sku: string; garments: string[]; models: string[]; crops: string[]; note?: string }[]
}

export interface RunSummary {
  runId: string
  runDir: string
  graph: string
  report: string
  startedAt: string | null
  params: RunParams | null
  status: RunStatus
  statusText: string
  counts: RunCounts
  /** 重出的来源 runId */
  derivedFrom: string | null
  /** 可编辑节点图地址（start_run / rerun 拉起编辑服务成功时） */
  editorUrl?: string
}

export interface RunDetail extends RunSummary {
  elapsedSeconds: number | null
  current: { sku: string; model: string } | null
  groups: {
    sku: string
    note?: string
    /** 固定模特、一对一：这个组合用的衣服图（绝对路径），重出时作 item 传给 rerun */
    item?: string
    pairing?: RunGroup['pairing']
    keepFrame?: boolean
    swap: SwapMode
    /** 绝对路径 */
    references: { file: string; role?: string }[]
    referenceSource: RunGroup['referenceSource']
    prompt: string
    promptEdited: boolean
    shots: { model: string; state: ShotState; stateText: string; result?: string; delivered?: string; error?: string; extraPrompt?: string }[]
  }[]
}

const STATUS_TEXT: Record<RunStatus, string> = {
  running: '进行中',
  completed: '已完成',
  partial: '部分失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

const STATE_TEXT: Record<ShotState, string> = {
  queued: '排队',
  generating: '生成中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

async function requireRoot(sourceRoot: string): Promise<string> {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) {
    throw new RunnerError('VALIDATION_ERROR', `sourceRoot 必须是绝对路径：${String(sourceRoot)}`)
  }
  const info = await stat(sourceRoot).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new RunnerError('VALIDATION_ERROR', `素材根目录不存在：${sourceRoot}`)
  }
  return path.resolve(sourceRoot)
}

function summary(record: RunRecord): RunSummary {
  const status = effectiveStatus(record)
  return {
    runId: record.runId,
    runDir: record.runDir,
    graph: record.graphPath,
    report: record.reportPath,
    startedAt: record.startedAt,
    params: record.params,
    status,
    statusText: STATUS_TEXT[status],
    counts: record.counts,
    derivedFrom: record.derivedFrom,
  }
}

function detail(record: RunRecord): RunDetail {
  const base = summary(record)
  const started = record.startedAt === null ? Number.NaN : Date.parse(record.startedAt)
  const end = base.status === 'running'
    ? Date.now()
    : Date.parse(record.finishedAt ?? record.heartbeatAt ?? new Date().toISOString())
  return {
    ...base,
    elapsedSeconds: Number.isFinite(started) ? Math.max(0, Math.round((end - started) / 1000)) : null,
    current: base.status === 'running' ? record.current : null,
    groups: record.groups.map((group) => ({
      sku: group.sku,
      ...(group.note === undefined ? {} : { note: group.note }),
      ...(group.item === undefined ? {} : { item: path.join(record.sourceRoot, group.item) }),
      ...(group.pairing === undefined ? {} : { pairing: group.pairing }),
      ...(group.keepFrame === undefined ? {} : { keepFrame: group.keepFrame }),
      swap: group.swap,
      references: group.references.map((ref) => ({
        file: path.join(record.sourceRoot, ref.file),
        ...(ref.role === undefined ? {} : { role: ref.role }),
      })),
      referenceSource: group.referenceSource,
      prompt: group.prompt,
      promptEdited: group.promptEdited,
      shots: group.shots.map((shot) => ({
        model: path.join(record.sourceRoot, shot.model),
        // 已中断的 run 里停在生成中/排队的单张按原样显示
        state: shot.state,
        stateText: STATE_TEXT[shot.state],
        ...(shot.result === undefined ? {} : { result: path.join(record.runDir, shot.result) }),
        ...(shot.delivered === undefined ? {} : { delivered: path.join(record.sourceRoot, shot.delivered) }),
        ...(shot.error === undefined ? {} : { error: shot.error }),
        ...(shot.extraPrompt === undefined ? {} : { extraPrompt: shot.extraPrompt }),
      })),
    })),
  }
}

async function findRun(root: string, runId: string | undefined): Promise<RunRecord> {
  if (runId === undefined) {
    const [latest] = await listRunRecords(root)
    if (latest === undefined) throw new RunnerError('NOT_FOUND', '这个素材目录还没有出过图')
    return latest
  }
  if (!RUN_ID_PATTERN.test(runId)) throw new RunnerError('VALIDATION_ERROR', `runId 格式不对：${runId}`)
  return readRunRecord(path.join(runsDir(root), runId))
}

export async function scanTool(input: { sourceRoot: string }): Promise<ScanToolResult> {
  const root = await requireRoot(input.sourceRoot)
  const groups = await scanSimple(root)
  return {
    sourceRoot: root,
    groups: await Promise.all(groups.map(async (group) => {
      const crops = await listCrops(root, group.sku)
      const note = group.garments.length === 0 && crops.length === 0
        ? '缺少服装图'
        : group.models.length === 0 ? '缺少模特图' : undefined
      return {
        sku: group.sku,
        garments: group.garments.map((file) => file.sourcePath),
        models: group.models.map((file) => file.sourcePath),
        crops,
        ...(note === undefined ? {} : { note }),
      }
    })),
  }
}

export async function cropTool(input: { sourceRoot: string; plan: unknown; replace?: boolean | undefined }): Promise<{ groups: { sku: string; files: string[] }[] }> {
  const root = await requireRoot(input.sourceRoot)
  const outcomes = await applyCropPlan(root, parseCropPlan(input.plan), { replace: input.replace === true })
  return { groups: outcomes.map((outcome) => ({ sku: outcome.sku, files: outcome.files.map((file) => path.join(root, file)) })) }
}

export async function startRunTool(input: StartRunInput, config: LaunchConfig): Promise<RunSummary> {
  const root = await requireRoot(input.sourceRoot)
  // 与 runSimple 相同的扫描与款号校验，出错时不创建 run
  const scanned = await scanTool({ sourceRoot: root })
  if (scanned.groups.length === 0) throw new RunnerError('VALIDATION_ERROR', `没有找到 服装/模特 目录：${root}`)
  const missing = (input.skus ?? []).filter((sku) => !scanned.groups.some((group) => group.sku === sku))
  if (missing.length > 0) throw new RunnerError('VALIDATION_ERROR', `找不到款号：${missing.join('、')}`)
  const selected = input.skus === undefined || input.skus.length === 0
    ? scanned.groups
    : scanned.groups.filter((group) => input.skus!.includes(group.sku))
  if (selected.every((group) => group.note !== undefined)) {
    throw new RunnerError('NO_RUNNABLE_TASKS', '没有可出图的款：每款都缺服装图或模特图')
  }
  await checkStartable(root, input.engine, config)
  const record = await launchRun(root, { ...input, sourceRoot: root, open: false }, config)
  return { ...summary(record), ...await openEditable(record, input.open, config) }
}

/** 拉起编辑服务并打开可编辑节点图；失败时退回打开 graph.html，不影响出图。 */
async function openEditable(record: RunRecord, open: boolean | undefined, config: LaunchConfig): Promise<{ editorUrl?: string }> {
  if (open === false) return {}
  try {
    const { origin, token } = await ensureEditor(record.sourceRoot, config)
    const editorUrl = editorPageUrl(origin, token, record.runId)
    config.openUrl?.(editorUrl)
    return { editorUrl }
  } catch {
    config.openUrl?.(record.graphPath)
    return {}
  }
}

/** 占用检查与 apimart 缺密钥检查，都在拉起进程前报错。 */
async function checkStartable(root: string, engine: string | undefined, config: LaunchConfig): Promise<void> {
  const active = await readActiveLock(root)
  if (active !== null) throw new RunnerError('RUN_IN_PROGRESS', `这个素材目录正在出图：${active.runId}`)
  if (engine === 'apimart') {
    const runnerConfig = loadRunnerConfig(config.env ?? process.env, {})
    requireApimartConfig(runnerConfig)
    if (runnerConfig.imageModel === undefined) throw new RunnerError('CONFIG_ERROR', 'IMAGE_MODEL')
  }
}

/** 其余字段即 RerunRequest，由 parseRerunRequest 校验 */
export interface RerunToolInput {
  sourceRoot: string
  open?: boolean | undefined
  engine?: RerunRequest['engine'] | undefined
  [key: string]: unknown
}

export async function rerunTool(input: RerunToolInput, config: LaunchConfig): Promise<RunSummary> {
  const root = await requireRoot(input.sourceRoot)
  const { sourceRoot: _sourceRoot, open, ...request } = input
  await checkStartable(root, input.engine, config)
  // 计划出错时不创建 run
  const plan = await buildRerunPlan(root, parseRerunRequest(request), config.env ?? process.env)
  const record = await launchRerun(root, plan, { ...config, open: false })
  return { ...summary(record), ...await openEditable(record, open, config) }
}

/** 页面新建出图（/api/new-run）：其余字段即 NewRunRequest；不注册为 MCP 工具。 */
export async function newRunTool(input: RerunToolInput, config: LaunchConfig): Promise<RunSummary> {
  const root = await requireRoot(input.sourceRoot)
  const { sourceRoot: _sourceRoot, open, ...request } = input
  await checkStartable(root, input.engine, config)
  // 计划出错时不创建 run
  const plan = await buildNewRunPlan(root, parseNewRunRequest(request), config.env ?? process.env)
  const record = await launchRerun(root, plan, { ...config, open: false })
  return { ...summary(record), ...await openEditable(record, open, config) }
}

/** 合集页「重出这 N 张」（/api/redo/run）：其余字段即 RedoRequest；与新建出图走同一条后台通路，不注册为 MCP 工具。 */
export async function redoRunTool(input: RerunToolInput, config: LaunchConfig): Promise<RunSummary> {
  const root = await requireRoot(input.sourceRoot)
  const { sourceRoot: _sourceRoot, open, ...request } = input
  await checkStartable(root, input.engine, config)
  const env = config.env ?? process.env
  // 计划出错时不创建 run
  const plan = await buildRedoPlan(root, parseRedoRequest(request), env.FASHION_TRYON_FAKE_ENGINE !== undefined ? 'fake' : 'codex')
  const record = await launchRerun(root, plan, { ...config, open: false })
  return { ...summary(record), ...await openEditable(record, open, config) }
}

export async function openGraphTool(
  input: { sourceRoot: string; runId?: string | undefined; open?: boolean | undefined },
  config: LaunchConfig,
): Promise<{ runId: string | null; url: string }> {
  const root = await requireRoot(input.sourceRoot)
  // 没给 runId：打开合集页
  const record = input.runId === undefined ? undefined : await findRun(root, input.runId)
  const { origin, token } = await ensureEditor(root, config)
  const url = record === undefined ? editorMaterialsUrl(origin, token) : editorPageUrl(origin, token, record.runId)
  if (input.open !== false) config.openUrl?.(url)
  return { runId: record?.runId ?? null, url }
}

export async function runStatusTool(input: { sourceRoot: string; runId?: string | undefined }): Promise<RunDetail> {
  const root = await requireRoot(input.sourceRoot)
  return detail(await findRun(root, input.runId))
}

export async function cancelRunTool(input: { sourceRoot: string; runId: string }): Promise<RunDetail> {
  const root = await requireRoot(input.sourceRoot)
  return detail(await stopRun(await findRun(root, input.runId)))
}

export async function listRunsTool(input: { sourceRoot: string }): Promise<{ runs: RunSummary[] }> {
  const root = await requireRoot(input.sourceRoot)
  return { runs: (await listRunRecords(root)).map(summary) }
}
