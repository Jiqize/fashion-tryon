import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readLastRoot, writeLastRoot } from '../src/editor/last-root.js'
import {
  addProject,
  displayName,
  findProjectByRoot,
  listProjects,
  projectsPath,
  removeProject,
  renameProject,
  restoreProject,
} from '../src/editor/projects.js'

let home: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-projects-'))
  env = { FASHION_TRYON_HOME: home }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('project list', () => {
  it('is empty and writes nothing without projects.json or last-root', async () => {
    expect(await listProjects(env)).toEqual([])
    expect(await readdir(home)).toEqual([])
  })

  it('brings in last-root once as the first project', async () => {
    await writeLastRoot(env, '/x/AI')
    const projects = await listProjects(env)
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ root: '/x/AI' })
    expect(projects[0]?.id).toMatch(/^[0-9a-f]{12}$/)
    await readFile(projectsPath(env), 'utf8')

    await rm(path.join(home, 'last-root'))
    expect(await listProjects(env)).toEqual(projects)
  })

  it('adds a folder only once by resolved path', async () => {
    const first = await addProject(env, '/x/A')
    expect(first.added).toBe(true)
    expect(first.entry).toMatchObject({ root: '/x/A' })
    const second = await addProject(env, '/x/A/')
    expect(second).toEqual({ entry: first.entry, added: false })
    expect(await listProjects(env)).toHaveLength(1)
    expect(await findProjectByRoot(env, '/x/A/')).toEqual(first.entry)
    expect(await findProjectByRoot(env, '/x/B')).toBeUndefined()
  })

  it('renames, clears the name and limits it to 40 characters', async () => {
    const { entry } = await addProject(env, '/x/AI')
    expect(displayName(entry)).toBe('AI')
    expect(displayName(await renameProject(env, entry.id, '26冬毛绒'))).toBe('26冬毛绒')
    expect(displayName((await listProjects(env))[0]!)).toBe('26冬毛绒')
    const cleared = await renameProject(env, entry.id, '  ')
    expect(cleared.name).toBeUndefined()
    expect(displayName(cleared)).toBe('AI')
    await expect(renameProject(env, entry.id, '毛'.repeat(41))).rejects.toThrow('显示名最长 40 字')
    await expect(renameProject(env, 'nope', 'x')).rejects.toThrow('找不到这个项目')
  })

  it('removes and restores an entry unchanged', async () => {
    const { entry } = await addProject(env, '/x/AI', new Date('2026-10-01T00:00:00.000Z'))
    const removed = await removeProject(env, entry.id)
    expect(removed).toEqual(entry)
    expect(await listProjects(env)).toEqual([])
    expect(await restoreProject(env, removed)).toEqual(entry)
    expect(await listProjects(env)).toEqual([entry])
    expect((await listProjects(env))[0]?.addedAt).toBe('2026-10-01T00:00:00.000Z')
    // 同 root 已存在时不重复
    expect(await restoreProject(env, removed)).toEqual(entry)
    expect(await listProjects(env)).toHaveLength(1)
  })

  it('refuses a corrupt file without overwriting it', async () => {
    await addProject(env, '/x/AI')
    await writeFile(projectsPath(env), '{ broken', 'utf8')
    await expect(listProjects(env)).rejects.toThrow(`项目列表文件损坏：${projectsPath(env)}`)
    await expect(addProject(env, '/x/B')).rejects.toThrow('项目列表文件损坏')
    expect(await readFile(projectsPath(env), 'utf8')).toBe('{ broken')
  })

  it('keeps both of two concurrent adds', async () => {
    await Promise.all([addProject(env, '/x/A'), addProject(env, '/x/B')])
    expect((await listProjects(env)).map((entry) => entry.root).sort()).toEqual(['/x/A', '/x/B'])
  })

  it('keeps last-root behavior', async () => {
    expect(await readLastRoot(env)).toBeUndefined()
    await writeLastRoot(env, '/x/AI')
    expect(await readLastRoot(env)).toBe('/x/AI')
  })
})

describe('isolated home', () => {
  it('points FASHION_TRYON_HOME at a temporary folder for every test file', () => {
    expect(process.env.FASHION_TRYON_HOME).toBeDefined()
    expect(process.env.FASHION_TRYON_HOME?.startsWith(tmpdir())).toBe(true)
  })
})
