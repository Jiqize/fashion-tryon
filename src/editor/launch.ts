import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { RunnerError } from '../errors.js'
import type { LaunchConfig } from '../mcp/launch.js'
import { runsDir } from '../simple/record.js'
import { pingEditor, readEditorSession } from './server.js'

// 确保某素材根目录的编辑服务在运行：会话文件指向的服务还活着就复用，否则在后台拉起 `fashion-tryon editor`

const START_TIMEOUT_MS = 10_000
const POLL_MS = 200
const EXIT_GRACE_MS = 2000

async function liveSession(root: string): Promise<{ origin: string; token: string } | undefined> {
  const session = await readEditorSession(root)
  if (session === undefined || !(await pingEditor(session))) return undefined
  return { origin: `http://127.0.0.1:${String(session.port)}`, token: session.token }
}

export interface ServiceLaunch {
  /** 会话文件指向的服务还活着时返回它 */
  live: () => Promise<{ origin: string; token: string } | undefined>
  /** 跟在 cliCommand 后面的参数 */
  args: string[]
  logPath: string
  /** 报错文案，例如「编辑服务」 */
  label: string
}

/** 服务在跑就复用，否则在后台拉起 CLI 子进程并等它就绪。 */
export async function ensureService(launch: ServiceLaunch, config: LaunchConfig): Promise<{ origin: string; token: string }> {
  const live = await launch.live()
  if (live !== undefined) return live

  await mkdir(path.dirname(launch.logPath), { recursive: true })
  const [command, ...prefix] = config.cliCommand
  if (command === undefined) throw new RunnerError('CONFIG_ERROR', '没有配置出图命令')
  const log = openSync(launch.logPath, 'a')
  let exited = false
  try {
    const child = spawn(command, [...prefix, ...launch.args], {
      detached: true,
      stdio: ['ignore', log, log],
      env: config.env ?? process.env,
    })
    child.on('exit', () => { exited = true })
    child.on('error', () => { exited = true })
    child.unref()
  } finally {
    closeSync(log)
  }

  // 并发拉起时后来的进程会退出，以会话文件里存活的服务为准；自己的进程退出后再等一小会儿
  let deadline = Date.now() + START_TIMEOUT_MS
  let sawExit = false
  for (;;) {
    const ready = await launch.live()
    if (ready !== undefined) return ready
    if (exited && !sawExit) {
      sawExit = true
      deadline = Math.min(deadline, Date.now() + EXIT_GRACE_MS)
    }
    if (Date.now() > deadline) throw new RunnerError('IO_ERROR', `${launch.label}未能启动，见 ${launch.logPath}`)
    await sleep(POLL_MS)
  }
}

export function ensureEditor(sourceRoot: string, config: LaunchConfig): Promise<{ origin: string; token: string }> {
  const root = path.resolve(sourceRoot)
  return ensureService({
    live: () => liveSession(root),
    args: ['editor', root, '--no-open', '--json'],
    logPath: path.join(runsDir(root), 'editor.log'),
    label: '编辑服务',
  }, config)
}
