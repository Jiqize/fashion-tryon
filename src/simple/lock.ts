import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'

// 同一素材根目录同一时间只允许一个出图：成图/_runs/.lock 独占创建
// 持有进程已死或内容损坏的锁视为陈旧，删除后重取

export interface RunLock {
  runId: string
  pid: number
  startedAt: string
}

/** process.kill(pid, 0)：ESRCH 为已退出，EPERM 说明进程在但不属于本用户。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockPath(sourceRoot: string): string {
  return path.join(sourceRoot, '成图', '_runs', '.lock')
}

async function readLockFile(sourceRoot: string): Promise<RunLock | 'missing' | 'corrupt'> {
  let text: string
  try {
    text = await readFile(lockPath(sourceRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  try {
    const value = JSON.parse(text) as Partial<RunLock>
    if (typeof value.runId === 'string' && typeof value.pid === 'number' && typeof value.startedAt === 'string') {
      return { runId: value.runId, pid: value.pid, startedAt: value.startedAt }
    }
  } catch {
    // 落到下面按损坏处理
  }
  return 'corrupt'
}

async function createLock(sourceRoot: string, lock: RunLock): Promise<boolean> {
  try {
    const handle = await open(lockPath(sourceRoot), 'wx', 0o644)
    try {
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export async function acquireRunLock(
  sourceRoot: string,
  lock: RunLock,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<void> {
  await mkdir(path.dirname(lockPath(sourceRoot)), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createLock(sourceRoot, lock)) return
    const existing = await readLockFile(sourceRoot)
    if (existing === 'missing') continue
    if (existing !== 'corrupt' && isAlive(existing.pid)) {
      throw new RunnerError('RUN_IN_PROGRESS', `这个素材目录正在出图：${existing.runId}`)
    }
    await rm(lockPath(sourceRoot), { force: true })
  }
  throw new RunnerError('RUN_IN_PROGRESS', '这个素材目录正在出图')
}

export async function releaseRunLock(sourceRoot: string, runId: string): Promise<void> {
  const existing = await readLockFile(sourceRoot)
  if (typeof existing === 'object' && existing.runId === runId) {
    await rm(lockPath(sourceRoot), { force: true })
  }
}

/** 持有进程仍存活的锁；没有锁或锁已陈旧时返回 null。 */
export async function readActiveLock(
  sourceRoot: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<RunLock | null> {
  const existing = await readLockFile(sourceRoot)
  return typeof existing === 'object' && isAlive(existing.pid) ? existing : null
}
