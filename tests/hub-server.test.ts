import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureHub } from '../src/editor/hub-launch.js'
import { hubSessionPath, readHubSession, startHubServer, type HubServerOptions } from '../src/editor/hub-server.js'
import { writeLastRoot } from '../src/editor/last-root.js'
import { addProject } from '../src/editor/projects.js'
import { readEditorSession } from '../src/editor/server.js'
import type { LaunchConfig } from '../src/mcp/tools.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
const editorRoots: string[] = []
const pids: number[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of editorRoots.splice(0)) {
    const session = await readEditorSession(root)
    if (session !== undefined) pids.push(session.pid)
  }
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function launchFor(home: string): LaunchConfig {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('APIMART_') || key === 'IMAGE_MODEL') delete env[key]
  }
  return {
    cliCommand: [process.execPath, '--import', 'tsx', path.resolve('src/cli.ts')],
    env: { ...env, FASHION_TRYON_HOME: home, FASHION_TRYON_FAKE_ENGINE: '{}' },
  }
}

/** 一款：一张衣服图、一张模特图，可选一张成图 */
async function materials(withOutput: boolean): Promise<string> {
  const root = await tempDir('hub-materials-')
  const files = ['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', ...(withOutput ? ['成图/EX1/a.jpg'] : [])]
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

async function startHub(overrides: Partial<HubServerOptions> = {}): Promise<{ home: string; hub: Awaited<ReturnType<typeof startHubServer>>; cookie: string }> {
  const home = overrides.launch?.env?.FASHION_TRYON_HOME ?? await tempDir('hub-home-')
  const hub = await startHubServer({ launch: launchFor(home), ...overrides })
  closers.push(() => hub.close())
  const page = await fetch(hub.url)
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!
  return { home, hub, cookie }
}

function api(hub: { origin: string }, cookie: string) {
  return {
    get: (route: string) => fetch(`${hub.origin}${route}`, { headers: { cookie } }),
    post: (route: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${hub.origin}${route}`, {
      method: 'POST',
      headers: { cookie, origin: hub.origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  }
}

async function listing(dir: string): Promise<string[]> {
  // 封面缩略图缓存（成图/_runs/.thumbs/）允许写
  return (await readdir(dir, { recursive: true })).map(String).filter((name) => !name.includes('.thumbs') && name !== path.join('成图', '_runs')).sort()
}

describe('hub server', () => {
  it('requires the token, then accepts the ft_hub cookie', async () => {
    const home = await tempDir('hub-home-')
    const hub = await startHubServer({ launch: launchFor(home) })
    closers.push(() => hub.close())
    expect((await fetch(`${hub.origin}/`)).status).toBe(401)
    expect((await fetch(`${hub.origin}/api/projects`)).status).toBe(401)
    const page = await fetch(hub.url)
    expect(page.status).toBe(200)
    const cookie = page.headers.get('set-cookie')!
    expect(cookie).toMatch(/^ft_hub=[^;]+; HttpOnly; SameSite=Strict; Path=\//)
    expect((await fetch(`${hub.origin}/api/projects`, { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(200)
    expect((await fetch(`${hub.origin}/api/ping?token=${hub.token}`)).status).toBe(200)
  })

  it('checks Origin on POST and serves the page with a strict CSP', async () => {
    const { hub, cookie } = await startHub()
    const { post, get } = api(hub, cookie)
    expect((await post('/api/projects/remove', { id: 'x' }, { origin: '' })).status).toBe(403)
    expect((await post('/api/projects/remove', { id: 'x' }, { origin: 'http://evil.example' })).status).toBe(403)
    const page = await get('/')
    const html = await page.text()
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    const { createHash } = await import('node:crypto')
    expect(csp).toContain(`'sha256-${createHash('sha256').update(style).digest('base64')}'`)
    expect(html).toContain('/ui/projects.js')
  })

  it('lists sorted cards and brings in last-root first', async () => {
    const home = await tempDir('hub-home-')
    const withRun = await materials(true)
    await writeLastRoot({ FASHION_TRYON_HOME: home }, withRun)
    const { hub, cookie } = await startHub({ launch: launchFor(home) })
    const { projects } = await (await api(hub, cookie).get('/api/projects')).json() as { projects: { root: string; skuCount: number; outputCount: number }[] }
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ root: withRun, skuCount: 1, outputCount: 1 })
  })

  it('picks a folder, opens its collection page and refuses the home folder', async () => {
    const root = await materials(false)
    editorRoots.push(root)
    let picked: string | null = root
    const { hub, cookie } = await startHub({ pickFolder: async () => picked })
    const { post } = api(hub, cookie)
    const before = await listing(root)

    const first = await post('/api/projects/pick')
    expect(first.status).toBe(200)
    const body = await first.json() as { id: string; added: boolean; url: string }
    expect(body.added).toBe(true)
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/materials\/\?token=[0-9a-f]+$/)
    expect(new URL(body.url).origin).not.toBe(hub.origin)
    const again = await (await post('/api/projects/pick')).json() as { id: string; added: boolean }
    expect(again).toMatchObject({ id: body.id, added: false })

    picked = null
    expect(await (await post('/api/projects/pick')).json()).toEqual({ cancelled: true })
    for (const bad of [homedir(), '/']) {
      picked = bad
      const refused = await post('/api/projects/pick')
      expect(refused.status).toBe(400)
      expect(JSON.stringify(await refused.json())).toContain('请选一个具体的素材文件夹')
    }
    picked = path.join(root, '服装', 'EX1', 'g1.jpg')
    const notDir = await post('/api/projects/pick')
    expect(notDir.status).toBe(400)
    expect(JSON.stringify(await notDir.json())).toContain('不是文件夹')

    // 打开已在列表里的项目同样得到合集页
    const opened = await (await post('/api/projects/open', { id: body.id })).json() as { url: string }
    expect(new URL(opened.url).origin).toBe(new URL(body.url).origin)
    // 编辑服务自己的会话与日志在 成图/_runs/ 里，素材本身不变
    expect((await listing(root)).filter((name) => !name.startsWith('成图'))).toEqual(before)
  })

  it('renames, removes, restores and reveals without touching the folder', async () => {
    const root = await materials(true)
    const revealed: string[] = []
    const { home, hub, cookie } = await startHub({ revealFolder: (dir) => { revealed.push(dir) } })
    const { post, get } = api(hub, cookie)
    const { entry } = await addProject({ FASHION_TRYON_HOME: home }, root)
    const before = await listing(root)

    const tooLong = await post('/api/projects/rename', { id: entry.id, name: '毛'.repeat(41) })
    expect(tooLong.status).toBe(400)
    expect(JSON.stringify(await tooLong.json())).toContain('显示名最长 40 字')
    const renamed = await (await post('/api/projects/rename', { id: entry.id, name: '26冬毛绒' })).json() as { project: { name: string } }
    expect(renamed.project.name).toBe('26冬毛绒')

    expect((await post('/api/projects/reveal', { id: entry.id })).status).toBe(200)
    expect(revealed).toEqual([root])

    const cover = await get(`/cover/${entry.id}`)
    expect(cover.status).toBe(200)
    expect(cover.headers.get('content-type')).toBe('image/jpeg')

    const removed = await (await post('/api/projects/remove', { id: entry.id })).json() as { removed: unknown }
    expect((await (await get('/api/projects')).json() as { projects: unknown[] }).projects).toEqual([])
    const restored = await post('/api/projects/restore', { entry: removed.removed })
    expect(restored.status).toBe(200)
    expect((await (await get('/api/projects')).json() as { projects: { id: string; name: string }[] }).projects).toMatchObject([{ id: entry.id, name: '26冬毛绒' }])

    const unknown = await post('/api/projects/open', { id: 'nope' })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(await unknown.json())).toContain('找不到这个项目')
    expect(await listing(root)).toEqual(before)
  })

  it('refuses to open or reveal a missing folder and has no cover for an empty one', async () => {
    const parent = await tempDir('hub-missing-')
    const gone = path.join(parent, 'gone')
    const empty = path.join(parent, 'empty')
    await mkdir(gone)
    await mkdir(empty)
    const { home, hub, cookie } = await startHub()
    const env = { FASHION_TRYON_HOME: home }
    const missing = (await addProject(env, gone)).entry
    const blank = (await addProject(env, empty)).entry
    await rm(gone, { recursive: true })
    const { post, get } = api(hub, cookie)
    for (const route of ['/api/projects/open', '/api/projects/reveal']) {
      const refused = await post(route, { id: missing.id })
      expect(refused.status).toBe(400)
      expect(JSON.stringify(await refused.json())).toContain('找不到文件夹')
    }
    expect((await get(`/cover/${missing.id}`)).status).toBe(404)
    expect((await get(`/cover/${blank.id}`)).status).toBe(404)
    expect(await readdir(empty)).toEqual([])
  })

  it('refuses a second hub while the first is alive and removes its session on close', async () => {
    const home = await tempDir('hub-home-')
    const first = await startHubServer({ launch: launchFor(home) })
    await expect(startHubServer({ launch: launchFor(home) })).rejects.toThrow('项目服务已在运行')
    const session = await readHubSession({ FASHION_TRYON_HOME: home })
    expect(session?.pid).toBe(process.pid)
    await first.close()
    await expect(readdir(home)).resolves.not.toContain(path.basename(hubSessionPath({ FASHION_TRYON_HOME: home })))
  })

  it('ensureHub starts the hub once and reuses it', async () => {
    const home = await tempDir('hub-home-')
    const first = await ensureHub(launchFor(home))
    const session = await readHubSession({ FASHION_TRYON_HOME: home })
    pids.push(session!.pid)
    expect(session!.pid).not.toBe(process.pid)
    expect(first.origin).toBe(`http://127.0.0.1:${String(session!.port)}`)
    const second = await ensureHub(launchFor(home))
    expect(second).toEqual(first)
  })
})

