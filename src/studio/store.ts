import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { RunnerError } from '../errors.js'
import { batchStateSchema, type BatchState } from './model.js'

export interface RunLock {
  readonly runDir: string
  release(): Promise<void>
}

interface RunLockFile {
  pid: number
  startedAt: string
}

// 同进程内的持有登记：同一 run 的两次 acquire 必须有一次失败，不做重入计数。
const heldRunLocks = new Set<string>()

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLockFile(lockPath: string): Promise<RunLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<RunLockFile>
    if (typeof parsed.pid !== 'number') return undefined
    return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? '') }
  } catch {
    return undefined
  }
}

/**
 * 清理上一次运行遗留的版本临时文件。只在持有 run 锁时调用，此时保证没有第二个写者。
 */
async function cleanupStaleTemporaries(imagesDir: string): Promise<void> {
  const entries = await readdir(imagesDir).catch(() => [])
  for (const entry of entries) {
    if (!entry.includes('.tmp-')) continue
    await rm(path.join(imagesDir, entry), { force: true }).catch(() => undefined)
  }
}

/**
 * run 级排他锁：同一 run 目录同时只允许一个执行者。持有者进程已死则回收陈旧锁。
 */
export async function acquireRunLock(runDirectory: string): Promise<RunLock> {
  const runDir = path.resolve(runDirectory)
  const info = await stat(runDir).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new RunnerError('NOT_FOUND', `Run directory does not exist: ${runDir}`)
  }
  if (heldRunLocks.has(runDir)) {
    throw new RunnerError(
      'VALIDATION_ERROR',
      `Run is already executing (pid ${String(process.pid)})`,
    )
  }
  const lockPath = path.join(runDir, '.run.lock')
  const payload: RunLockFile = { pid: process.pid, startedAt: new Date().toISOString() }
  const write = async (): Promise<void> => {
    const handle = await open(lockPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  try {
    await write()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readLockFile(lockPath)
    if (existing !== undefined && isProcessAlive(existing.pid)) {
      throw new RunnerError(
        'VALIDATION_ERROR',
        `Run is already executing (pid ${String(existing.pid)})`,
      )
    }
    // 陈旧锁：持有进程已不存在，直接替换。
    await rm(lockPath, { force: true })
    await write()
  }
  heldRunLocks.add(runDir)
  await cleanupStaleTemporaries(path.join(runDir, 'images'))
  let released = false
  return {
    runDir,
    async release() {
      if (released) return
      released = true
      heldRunLocks.delete(runDir)
      await rm(lockPath, { force: true }).catch(() => undefined)
    },
  }
}

export interface BatchStore {
  readonly dir: string
  state(): BatchState
  update(mutator: (draft: BatchState) => void): Promise<BatchState>
  writeVersionImage(
    taskId: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<{ relativePath: string; sha256: string }>
  thumbnail(relativePath: string, edge: 480): Promise<string>
  resolve(relativePath: string): string
  close(): Promise<void>
}

class MutationQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r').catch(() => undefined)
  if (handle === undefined) return
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
    await fsyncDirectory(path.dirname(filePath))
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function extensionFor(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/webp') return 'webp'
  throw new RunnerError('VALIDATION_ERROR', `Unsupported image media type: ${mediaType}`)
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

export function batchDirFor(sourceRoot: string): string {
  const resolved = path.resolve(sourceRoot)
  return path.join(path.dirname(resolved), `${path.basename(resolved)}-tryon-studio`)
}

function defaultState(sourceRoot: string, dir: string): BatchState {
  return {
    schemaVersion: 1,
    batchId: randomUUID(),
    // 只记相对批次目录的路径，不写绝对路径
    sourceRoot: toPosix(path.relative(dir, sourceRoot)),
    createdAt: new Date().toISOString(),
    settings: {
      mode: 'fixedClothing',
      scope: 'full',
      candidates: 1,
      concurrency: 5,
      size: '3:4',
      imageModel: process.env.IMAGE_MODEL ?? '',
    },
    groups: [],
    assets: [],
    tasks: [],
    generationCallsUsed: 0,
  }
}

async function readState(statePath: string): Promise<BatchState> {
  let text: string
  try {
    text = await readFile(statePath, 'utf8')
  } catch (error) {
    throw new RunnerError('IO_ERROR', `Cannot read batch state: ${statePath}`, { cause: error })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new RunnerError('INTEGRITY_ERROR', 'studio.json contains invalid JSON', { cause: error })
  }
  const parsed = batchStateSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RunnerError('INTEGRITY_ERROR', `studio.json is invalid: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * 只读批次状态：不加锁、不创建目录（供 status 命令在服务运行中查询）。
 */
export async function readBatchState(sourceRoot: string): Promise<{ dir: string; state: BatchState }> {
  const dir = batchDirFor(sourceRoot)
  const statePath = path.join(dir, 'studio.json')
  const exists = await stat(statePath).then((info) => info.isFile(), () => false)
  if (!exists) throw new RunnerError('NOT_FOUND', `Batch does not exist yet: ${dir}`)
  return { dir, state: await readState(statePath) }
}

/**
 * 打开（或创建）素材根目录对应的批次，并持有该批次的运行锁直到 close。
 */
export async function openBatch(sourceRoot: string): Promise<BatchStore> {
  const source = path.resolve(sourceRoot)
  const dir = batchDirFor(source)
  await mkdir(dir, { recursive: true })
  const lock = await acquireRunLock(dir)
  const statePath = path.join(dir, 'studio.json')

  let current: BatchState
  try {
    const exists = await stat(statePath).then(() => true, () => false)
    if (exists) {
      current = await readState(statePath)
    } else {
      current = defaultState(source, dir)
      await writeJsonAtomic(statePath, current)
    }
  } catch (error) {
    await lock.release()
    throw error
  }

  const queue = new MutationQueue()

  const resolve = (relativePath: string): string => {
    if (path.isAbsolute(relativePath)) {
      throw new RunnerError('VALIDATION_ERROR', 'Batch paths must be relative')
    }
    return path.resolve(dir, relativePath)
  }

  return {
    dir,
    state: () => current,
    update(mutator) {
      return queue.run(async () => {
        const draft = structuredClone(current)
        mutator(draft)
        const next = batchStateSchema.parse(draft)
        await writeJsonAtomic(statePath, next)
        current = next
        return current
      })
    },
    async writeVersionImage(taskId, bytes, mediaType) {
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
        throw new RunnerError('VALIDATION_ERROR', `Unsafe task id: ${taskId}`)
      }
      const extension = extensionFor(mediaType)
      const digest = sha256(bytes)
      // 序号 = 该任务已记录的版本数 + 1
      const task = current.tasks.find((candidate) => candidate.id === taskId)
      const sequence = String((task?.versions.length ?? 0) + 1).padStart(2, '0')
      const relativePath = `images/${taskId}/${sequence}-${digest.slice(0, 8)}.${extension}`
      const target = resolve(relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
        await handle.close()
        // link 在目标已存在时失败，保证不覆盖已有版本
        await link(temporary, target)
      } catch (error) {
        await handle.close().catch(() => undefined)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new RunnerError('INTEGRITY_ERROR', `Version image already exists: ${relativePath}`)
        }
        throw error
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
      return { relativePath, sha256: digest }
    },
    async thumbnail(relativePath, edge) {
      const sourcePath = resolve(relativePath)
      const sourceHash = sha256(await readFile(sourcePath))
      // 路径与源内容 hash 共同决定缓存名：源文件变化后自然生成新缩略图
      const name = `${sha256(relativePath).slice(0, 16)}-${sourceHash.slice(0, 16)}-${String(edge)}.jpg`
      const thumbRelative = `thumbs/${name}`
      const thumbPath = resolve(thumbRelative)
      const cached = await stat(thumbPath).then(() => true, () => false)
      if (cached) return thumbRelative
      await mkdir(path.dirname(thumbPath), { recursive: true })
      const bytes = await sharp(sourcePath)
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside' })
        .jpeg({ quality: 82 })
        .toBuffer()
      const temporary = `${thumbPath}.tmp-${process.pid}-${randomUUID()}`
      await writeFile(temporary, bytes, { mode: 0o600 })
      await rename(temporary, thumbPath)
      return thumbRelative
    },
    resolve,
    async close() {
      await queue.run(async () => undefined)
      await lock.release()
    },
  }
}
