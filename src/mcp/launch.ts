import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { RunnerError, redactSecrets, runnerErrorCodes, type RunnerErrorCode } from '../errors.js'
import { isProcessAlive } from '../simple/lock.js'
import type { SwapMode } from '../simple/prompt.js'
import { effectiveStatus, newRunId, readRunRecord, runsDir, type RunRecord } from '../simple/record.js'
import type { RerunPlan } from '../simple/rerun.js'

// 后台出图：拉起独立的 `fashion-tryon run` 子进程（detached），MCP 服务退出也不影响它
// 子进程的 stdout/stderr 都写进 run 目录的 run.log

export interface StartRunInput {
  sourceRoot: string
  swap?: SwapMode | undefined
  skus?: string[] | undefined
  maxReferences?: number | undefined
  engine?: 'codex' | 'apimart' | undefined
  open?: boolean | undefined
}

export interface LaunchConfig {
  /** 生产：[node, dist/cli.mjs]；测试：[node, --import, tsx, src/cli.ts] */
  cliCommand: string[]
  env?: NodeJS.ProcessEnv
  /** 等运行记录出现的最长时间，默认 10 秒 */
  waitMs?: number
  openUrl?: (url: string) => void
}

const POLL_MS = 200

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false)
}

/** 当前时间作 runId 并原子占下它的目录；目录已存在（含同一秒并发提交）就往后推一秒。 */
export async function claimRunDir(sourceRoot: string): Promise<{ runId: string; runDir: string }> {
  await mkdir(runsDir(sourceRoot), { recursive: true })
  for (let offset = 0; ; offset += 1) {
    const runId = newRunId(new Date(Date.now() + offset * 1000))
    const runDir = path.join(runsDir(sourceRoot), runId)
    try {
      await mkdir(runDir)
      return { runId, runDir }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** run.log 里最后一行带 error 的 JSON（CLI --json 的输出）。 */
async function lastError(logPath: string): Promise<RunnerError | undefined> {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  for (const line of text.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as { error?: { code?: string; message?: string; retryable?: boolean } }
      if (parsed.error !== undefined) {
        const code = runnerErrorCodes.includes(parsed.error.code as RunnerErrorCode)
          ? parsed.error.code as RunnerErrorCode
          : 'IO_ERROR'
        return new RunnerError(code, redactSecrets(parsed.error.message ?? '出图进程失败'), {
          retryable: parsed.error.retryable ?? false,
        })
      }
    } catch {
      // 不是 JSON 行
    }
  }
  return undefined
}

export async function launchRun(sourceRoot: string, args: StartRunInput, config: LaunchConfig): Promise<RunRecord> {
  const env = config.env ?? process.env
  const { runId, runDir } = await claimRunDir(sourceRoot)

  // 输入没给引擎、且测试环境开了假引擎时用 fake；明确给了就按输入
  const engine = args.engine ?? (env.FASHION_TRYON_FAKE_ENGINE !== undefined ? 'fake' : 'codex')
  return spawnAndWait(runDir, [
    'run', sourceRoot, '--json', '--no-open', '--run-id', runId,
    '--engine', engine,
    '--swap', args.swap ?? 'outfit',
    ...(args.maxReferences === undefined ? [] : ['--max-refs', String(args.maxReferences)]),
    ...(args.skus === undefined || args.skus.length === 0 ? [] : ['--sku', ...args.skus]),
  ], config, args.open)
}

/** 重出：计划写到 <runDir>/rerun-plan.json，拉起 `fashion-tryon rerun` 子进程。 */
export async function launchRerun(
  sourceRoot: string,
  plan: RerunPlan,
  config: LaunchConfig & { open?: boolean | undefined },
): Promise<RunRecord> {
  const { runId, runDir } = await claimRunDir(sourceRoot)
  const planPath = path.join(runDir, 'rerun-plan.json')
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`)
  return spawnAndWait(runDir, [
    'rerun', sourceRoot, '--plan', planPath, '--run-id', runId, '--engine', plan.engine, '--json', '--no-open',
  ], config, config.open)
}

/** 拉起 detached 子进程（输出写 run.log），等 run.json 出现；进程先退出则带回它的错误。 */
async function spawnAndWait(runDir: string, cliArgs: string[], config: LaunchConfig, open: boolean | undefined): Promise<RunRecord> {
  const env = config.env ?? process.env
  const logPath = path.join(runDir, 'run.log')
  const [command, ...prefix] = config.cliCommand
  if (command === undefined) throw new RunnerError('CONFIG_ERROR', '没有配置出图命令')
  const log = openSync(logPath, 'a')
  let exited = false
  try {
    const child = spawn(command, [...prefix, ...cliArgs], { detached: true, stdio: ['ignore', log, log], env })
    child.on('exit', () => { exited = true })
    child.on('error', () => { exited = true })
    child.unref()
  } finally {
    closeSync(log)
  }

  const deadline = Date.now() + (config.waitMs ?? 10_000)
  for (;;) {
    if (await exists(path.join(runDir, 'run.json'))) {
      const record = await readRunRecord(runDir)
      if (open !== false) config.openUrl?.(record.graphPath)
      return record
    }
    if (exited) {
      throw (await lastError(logPath)) ?? new RunnerError('IO_ERROR', `出图进程未能启动，见 ${logPath}`)
    }
    if (Date.now() > deadline) throw new RunnerError('IO_ERROR', `出图进程未能启动，见 ${logPath}`)
    await sleep(POLL_MS)
  }
}

/** 发 SIGTERM，等运行记录不再是进行中或进程已退出（最多 waitMs）。 */
export async function stopRun(record: RunRecord, waitMs = 15_000): Promise<RunRecord> {
  if (effectiveStatus(record) !== 'running' || record.pid === null) return record
  try {
    process.kill(record.pid, 'SIGTERM')
  } catch {
    // 进程刚好已退出
  }
  const deadline = Date.now() + waitMs
  let current = record
  while (Date.now() < deadline) {
    current = await readRunRecord(record.runDir)
    if (current.status !== 'running' || current.pid === null || !isProcessAlive(current.pid)) return current
    await sleep(POLL_MS)
  }
  return current
}
