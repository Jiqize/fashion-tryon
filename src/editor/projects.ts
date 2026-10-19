import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { RunnerError } from '../errors.js'
import { configDir, readLastRoot } from './last-root.js'

// 项目列表：一个项目就是一个素材根目录，只存本机 <配置目录>/projects.json，不写进素材目录

export interface ProjectEntry {
  id: string
  root: string
  name?: string
  addedAt: string
}

interface ProjectsFile {
  version: 1
  projects: ProjectEntry[]
}

const MAX_NAME_LENGTH = 40

const entrySchema = z.object({
  id: z.string(),
  root: z.string(),
  name: z.string().optional(),
  addedAt: z.string(),
})

const fileSchema = z.object({
  version: z.literal(1),
  projects: z.array(entrySchema),
})

export function projectsPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'projects.json')
}

export function displayName(entry: ProjectEntry): string {
  return entry.name ?? path.basename(entry.root)
}

export function projectId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12)
}

function newEntry(root: string, now: Date): ProjectEntry {
  const resolved = path.resolve(root)
  return { id: projectId(resolved), root: resolved, addedAt: now.toISOString() }
}

async function readProjectsFile(env: NodeJS.ProcessEnv): Promise<ProjectsFile | undefined> {
  const filePath = projectsPath(env)
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const corrupt = new RunnerError('VALIDATION_ERROR', `项目列表文件损坏：${filePath}`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw corrupt
  }
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success) throw corrupt
  return parsed.data as ProjectsFile
}

async function writeProjectsFile(env: NodeJS.ProcessEnv, state: ProjectsFile): Promise<void> {
  const filePath = projectsPath(env)
  await mkdir(path.dirname(filePath), { recursive: true })
  // 先写同目录临时文件再 rename，中途失败不会留下写了一半的列表
  const temporary = `${filePath}.tmp-${String(process.pid)}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

// 文件不存在时只带入一次 last-root；没有 last-root 就不建文件
async function loadProjects(env: NodeJS.ProcessEnv): Promise<ProjectsFile> {
  const existing = await readProjectsFile(env)
  if (existing !== undefined) return existing
  const lastRoot = await readLastRoot(env)
  const state: ProjectsFile = { version: 1, projects: [] }
  if (lastRoot !== undefined) {
    state.projects.push(newEntry(lastRoot, new Date()))
    await writeProjectsFile(env, state)
  }
  return state
}

// 同进程内按文件串行：后一次修改读到前一次的结果
const queues = new Map<string, Promise<unknown>>()

function serialized<T>(env: NodeJS.ProcessEnv, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectsPath(env))
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  queues.set(key, next)
  return next
}

/** mutate 返回 true 才写回文件 */
function updateProjects<T>(
  env: NodeJS.ProcessEnv,
  mutate: (state: ProjectsFile) => { result: T; changed: boolean },
): Promise<T> {
  return serialized(env, async () => {
    const state = await loadProjects(env)
    const { result, changed } = mutate(state)
    if (changed) await writeProjectsFile(env, state)
    return result
  })
}

function notFound(): RunnerError {
  return new RunnerError('VALIDATION_ERROR', '找不到这个项目')
}

export function listProjects(env: NodeJS.ProcessEnv): Promise<ProjectEntry[]> {
  return serialized(env, async () => (await loadProjects(env)).projects)
}

export async function findProjectByRoot(env: NodeJS.ProcessEnv, root: string): Promise<ProjectEntry | undefined> {
  const resolved = path.resolve(root)
  return (await listProjects(env)).find((entry) => entry.root === resolved)
}

export function addProject(
  env: NodeJS.ProcessEnv,
  root: string,
  now: Date = new Date(),
): Promise<{ entry: ProjectEntry; added: boolean }> {
  return updateProjects<{ entry: ProjectEntry; added: boolean }>(env, (state) => {
    const entry = newEntry(root, now)
    const existing = state.projects.find((item) => item.root === entry.root)
    if (existing !== undefined) return { result: { entry: existing, added: false }, changed: false }
    state.projects.push(entry)
    return { result: { entry, added: true }, changed: true }
  })
}

export function renameProject(env: NodeJS.ProcessEnv, id: string, name: string): Promise<ProjectEntry> {
  const trimmed = name.trim()
  if ([...trimmed].length > MAX_NAME_LENGTH) {
    return Promise.reject(new RunnerError('VALIDATION_ERROR', `显示名最长 ${String(MAX_NAME_LENGTH)} 字`))
  }
  return updateProjects(env, (state) => {
    const entry = state.projects.find((item) => item.id === id)
    if (entry === undefined) throw notFound()
    // 清空表示恢复为文件夹名
    if (trimmed === '') delete entry.name
    else entry.name = trimmed
    return { result: { ...entry }, changed: true }
  })
}

export function removeProject(env: NodeJS.ProcessEnv, id: string): Promise<ProjectEntry> {
  return updateProjects(env, (state) => {
    const index = state.projects.findIndex((item) => item.id === id)
    if (index < 0) throw notFound()
    const [removed] = state.projects.splice(index, 1)
    return { result: removed!, changed: true }
  })
}

export function restoreProject(env: NodeJS.ProcessEnv, entry: ProjectEntry): Promise<ProjectEntry> {
  return updateProjects(env, (state) => {
    const existing = state.projects.find((item) => item.root === entry.root)
    if (existing !== undefined) return { result: existing, changed: false }
    state.projects.push(entry)
    return { result: entry, changed: true }
  })
}
