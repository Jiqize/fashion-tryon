import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'
import { startEditorServer, editorMaterialsUrl, editorPageUrl } from '../src/editor/server.js'
import { cancelRunTool, startRunTool, type LaunchConfig } from '../src/mcp/tools.js'
import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import { scanSimple } from '../src/simple/layout.js'
import { readActiveLock } from '../src/simple/lock.js'
import { readRunRecord, runsDir } from '../src/simple/record.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
const pids: number[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const SOURCE = '20261015-090000'
const FILES = ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg']

function launch(delayMs = 200): LaunchConfig {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('APIMART_') || key === 'IMAGE_MODEL') delete env[key]
  }
  return {
    cliCommand: [process.execPath, '--import', 'tsx', path.resolve('src/cli.ts')],
    env: { ...env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs }) },
  }
}

async function sourceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'editor-server-'))
  roots.push(root)
  for (const [index, file] of FILES.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }] }))
  const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
  await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE, '--sku', 'EX1'], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
  return root
}

async function start(root: string, extra: { idleExitMs?: number; onIdle?: () => void; delayMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const { delayMs, env, ...rest } = extra
  const base = launch(delayMs)
  const server = await startEditorServer({ sourceRoot: root, launch: { ...base, env: { ...base.env, ...env } }, ...rest })
  closers.push(() => server.close())
  const get = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.origin}${pathname}${pathname.includes('?') ? '&' : '?'}token=${server.token}`, init)
  const post = (pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    get(pathname, {
      method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  return { server, get, post }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(100)
  }
}

async function waitFinished(root: string, runId: string): Promise<void> {
  await waitUntil(async () => (await readRunRecord(path.join(runsDir(root), runId))).status !== 'running')
  await waitUntil(async () => (await readActiveLock(root)) === null)
}

describe('editor server', () => {
  it('listens on 127.0.0.1 with a 0600 session file', async () => {
    const root = await sourceRoot()
    const { server } = await start(root)
    expect(new URL(server.origin).hostname).toBe('127.0.0.1')
    expect(server.url).toBe(`${server.origin}/?token=${server.token}`)
    expect(editorPageUrl(server.origin, server.token, SOURCE)).toBe(`${server.origin}/runs/${SOURCE}/?token=${server.token}`)
    const sessionPath = path.join(runsDir(root), '.editor.json')
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toEqual({ port: Number(new URL(server.origin).port), token: server.token, pid: process.pid })
    await server.close()
    await expect(stat(sessionPath)).rejects.toThrow()
  })

  it('requires the token, then accepts the cookie', async () => {
    const root = await sourceRoot()
    const { server } = await start(root)
    expect((await fetch(`${server.origin}/runs/${SOURCE}/run-data.js`)).status).toBe(401)
    const page = await fetch(editorPageUrl(server.origin, server.token, SOURCE))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    const cookie = page.headers.get('set-cookie')!
    expect(cookie).toMatch(/^ft_editor=[^;]+; HttpOnly; SameSite=Strict; Path=\//)
    const headers = { cookie: cookie.split(';')[0]! }
    expect((await fetch(`${server.origin}/runs/${SOURCE}/run-data.js`, { headers })).status).toBe(200)
    const thumb = await fetch(`${server.origin}/runs/${SOURCE}/ref/EX1/g1.jpg`, { headers })
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect((await fetch(`${server.origin}/runs/${SOURCE}/run.json`, { headers })).status).toBe(404)
  })

  it('serves the shared controls script behind the token', async () => {
    const root = await sourceRoot()
    const { server, get } = await start(root)
    const script = await get('/ui/controls.js')
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toContain('__UI__')
    // 沿用现有鉴权：不带 token 也没有 cookie 时拒绝
    expect((await fetch(`${server.origin}/ui/controls.js`)).status).toBe(401)
  })

  it('checks Origin and content type on POST', async () => {
    const root = await sourceRoot()
    const { post } = await start(root)
    const body = { references: [{ file: '服装/EX1/g1.jpg' }], swap: 'outfit' }
    expect((await post('/api/prompt', body, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await post('/api/prompt', body, { 'content-type': 'text/plain' })).status).toBe(415)
    const ok = await post('/api/prompt', body)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { prompt: string }).prompt).toContain('图2是这套服装的参考图')
  })

  it('serves only images from garments, models, crops and deliveries', async () => {
    const root = await sourceRoot()
    const { get } = await start(root)
    const garment = await get(`/source/${encodeURI('服装/EX1/g1.jpg')}`)
    expect(garment.status).toBe(200)
    expect(garment.headers.get('content-type')).toMatch(/^image\//)
    expect((await get(`/source/${encodeURI('裁图/EX1/01-全身-正面.jpg')}`)).status).toBe(200)
    expect((await get(`/source/${encodeURI('成图/EX1/m1.png')}`)).status).toBe(200)
    expect((await get('/source/%2E%2E/x.jpg')).status).toBe(404)
    expect((await get(`/source/${encodeURI(`成图/_runs/${SOURCE}/run.json`)}`)).status).toBe(404)
    expect((await get(`/source/${encodeURI(`成图/_runs/${SOURCE}/ref/EX1/g1.jpg`)}`)).status).toBe(404)
    expect((await get('/source/%E6%9C%8D%E8%A3%85%2FEX1%2Fg1.jpg')).status).toBe(404)
  })

  it('serves cached thumbnails and revalidates images by ETag', async () => {
    const root = await sourceRoot()
    const big = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#a08060' } }).jpeg().toBuffer()
    await writeFile(path.join(root, '模特/EX1/m1.jpg'), big)
    const { get } = await start(root)
    const thumbPath = `/thumb/${encodeURI('模特/EX1/m1.jpg')}`
    const thumb = await get(thumbPath)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect(await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).toMatchObject({ width: 240, height: 320 })
    expect(await readdir(path.join(runsDir(root), '.thumbs'))).toHaveLength(1)
    // 带上 ETag 再取：304
    const etag = thumb.headers.get('etag')!
    expect(thumb.headers.get('cache-control')).toBe('no-cache')
    expect((await get(thumbPath, { headers: { 'if-none-match': etag } })).status).toBe(304)
    const source = await get(`/source/${encodeURI('模特/EX1/m1.jpg')}`)
    expect((await get(`/source/${encodeURI('模特/EX1/m1.jpg')}`, { headers: { 'if-none-match': source.headers.get('etag')! } })).status).toBe(304)
    // 原图换了：ETag 变，生成新的缩略图
    await writeFile(path.join(root, '模特/EX1/m1.jpg'), await sharp({ create: { width: 400, height: 200, channels: 3, background: '#203040' } }).jpeg().toBuffer())
    const changed = await get(thumbPath, { headers: { 'if-none-match': etag } })
    expect(changed.status).toBe(200)
    expect(await sharp(Buffer.from(await changed.arrayBuffer())).metadata()).toMatchObject({ width: 320, height: 160 })
    // 小图不放大；与 /source/ 同样的白名单
    expect(await sharp(Buffer.from(await (await get(`/thumb/${encodeURI('服装/EX1/g1.jpg')}`)).arrayBuffer())).metadata()).toMatchObject({ width: 24, height: 32 })
    expect((await get(`/thumb/${encodeURI('成图/EX1/m1.png')}`)).status).toBe(200)
    expect((await get('/thumb/%2E%2E/x.jpg')).status).toBe(404)
    expect((await get(`/thumb/${encodeURI(`成图/_runs/${SOURCE}/ref/EX1/g1.jpg`)}`)).status).toBe(404)
  })

  it('returns the editor view of a run', async () => {
    const root = await sourceRoot()
    await writeFile(path.join(root, '模特/EX1/m3.jpg'), await fixtureImageBytes(8))
    const { get } = await start(root)
    const response = await get(`/api/runs/${SOURCE}/editor`)
    expect(response.status).toBe(200)
    const view = await response.json() as Record<string, unknown> & { groups: Record<string, unknown>[] }
    expect(view).toMatchObject({ runId: SOURCE, derivedFrom: null, activeRunId: null, maxReferences: 6, engineDefault: 'fake' })
    expect(view.groups).toEqual([{
      sku: 'EX1',
      settings: {
        swap: 'outfit',
        references: [{ file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }],
        prompt: expect.stringContaining('图2是这套服装的参考图') as unknown,
        promptEdited: false,
      },
      garments: ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg'],
      crops: ['裁图/EX1/01-全身-正面.jpg'],
      models: [
        { file: '模特/EX1/m1.jpg', inRun: true },
        { file: '模特/EX1/m2.jpg', inRun: true },
        { file: '模特/EX1/m3.jpg', inRun: false },
      ],
    }])
    expect((await get('/api/runs/20261015-120000/editor')).status).toBe(404)
  })

  it('asks before replacing a crop', async () => {
    const root = await sourceRoot()
    const { post } = await start(root)
    const conflict = await post('/api/crop', { sku: 'EX1', from: 'g2.jpg', role: '全身-正面' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'CROP_EXISTS', message: '裁图/EX1/ 里已有「全身-正面」，替换吗？' } })
    const added = await post('/api/crop', { sku: 'EX1', from: 'g2.jpg', role: '细节-领口', box: [0, 0, 500, 500] })
    expect(await added.json()).toEqual({ file: '裁图/EX1/02-细节-领口.jpg' })
  })

  it('reruns one shot, refuses a second while busy, and cancels like cancel_run', async () => {
    const root = await sourceRoot()
    const { server, post } = await start(root, { delayMs: 800 })
    const response = await post('/api/rerun', { fromRunId: SOURCE, shots: [{ sku: 'EX1', model: '模特/EX1/m2.jpg' }] })
    expect(response.status).toBe(200)
    const run = await response.json() as { runId: string; url: string; derivedFrom: string; counts: { planned: number } }
    pids.push((await readRunRecord(path.join(runsDir(root), run.runId))).pid!)
    expect(run).toMatchObject({ derivedFrom: SOURCE, counts: { planned: 1 } })
    expect(run.url).toBe(editorPageUrl(server.origin, server.token, run.runId))

    const busy = await post('/api/rerun', { fromRunId: SOURCE, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }] })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: { code: 'RUN_IN_PROGRESS', message: `这个素材目录正在出图：${run.runId}` } })

    const cancelled = await post(`/api/runs/${run.runId}/cancel`, {})
    expect(cancelled.status).toBe(200)
    const viaPage = await cancelled.json() as { status: string; counts: unknown }
    expect(viaPage.status).toBe('cancelled')
    const viaTool = await cancelRunTool({ sourceRoot: root, runId: run.runId })
    expect(viaPage).toEqual(JSON.parse(JSON.stringify(viaTool)))
  })

  it('never exposes the apimart key in responses, pages or run files', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as { port: number }
        probe.close(() => resolve(address.port))
      })
    })
    const secret = 'sk-test-leak-0123456789'
    const root = await sourceRoot()
    const { get, post } = await start(root, {
      env: { APIMART_API_KEY: secret, IMAGE_MODEL: 'fake', APIMART_BASE_URL: `http://127.0.0.1:${String(port)}` },
    })
    const response = await post('/api/rerun', { fromRunId: SOURCE, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }], engine: 'apimart' })
    const run = await response.json() as { runId: string; runDir: string }
    pids.push((await readRunRecord(run.runDir)).pid!)
    await waitFinished(root, run.runId)
    expect((await readRunRecord(run.runDir)).status).toBe('partial')
    const texts = [
      JSON.stringify(run),
      await (await get(`/api/runs/${run.runId}/editor`)).text(),
      await (await get(`/runs/${run.runId}/`)).text(),
      await (await get(`/runs/${run.runId}/run-data.js`)).text(),
      ...await Promise.all(['run.json', 'rerun-plan.json', 'run.log', 'report.html']
        .map((name) => readFile(path.join(run.runDir, name), 'utf8'))),
      await readFile(path.join(runsDir(root), '.editor.json'), 'utf8'),
    ]
    for (const text of texts) expect(text).not.toContain(secret)
  })

  it('calls onIdle after the idle period while a background run keeps going', async () => {
    const root = await sourceRoot()
    const run = await startRunTool({ sourceRoot: root, open: false }, launch(400))
    pids.push((await readRunRecord(run.runDir)).pid!)
    let idle = 0
    await start(root, { idleExitMs: 200, onIdle: () => { idle += 1 } })
    await waitUntil(async () => idle > 0, 3000)
    await waitFinished(root, run.runId)
    expect((await readRunRecord(run.runDir)).status).toBe('completed')
  })
})

describe('materials page and upload', () => {
  async function materialsRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'editor-materials-'))
    roots.push(root)
    for (const [index, file] of FILES.entries()) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
    }
    return root
  }

  const upload = (server: { origin: string; token: string }, query: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    fetch(`${server.origin}/api/upload?${query}&token=${server.token}`, {
      method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/octet-stream', ...headers },
      body,
    })

  it('opens the materials page when the root has no runs', async () => {
    const root = await materialsRoot()
    const { server, get } = await start(root)
    const home = await get('/', { redirect: 'manual' })
    expect(home.status).toBe(302)
    expect(home.headers.get('location')).toBe('/materials/')
    expect(editorMaterialsUrl(server.origin, server.token)).toBe(`${server.origin}/materials/?token=${server.token}`)
    const page = await fetch(editorMaterialsUrl(server.origin, server.token))
    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    const html = await page.text()
    expect(html).toContain('/ui/collection.js')
    // 共享控件脚本先于其它 /ui/ 脚本加载
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1])
    expect(scripts[0]).toBe('/ui/controls.js')
    expect((await get('/materials', { redirect: 'manual' })).headers.get('location')).toBe('/materials/')

    const view = await (await get('/api/collection')).json() as { activeRun: null; latestRunId: null; rootName: string; groups: { sku: string; garments: string[]; models: string[]; defaults: Record<string, unknown> }[] }
    expect(view).toMatchObject({ activeRun: null, latestRunId: null, maxReferences: 6, engineDefault: 'fake', rootName: path.basename(root), order: [], redo: [] })
    const scanned = await scanSimple(root)
    expect(view.groups.map((group) => [group.sku, group.garments.length, group.models.length]))
      .toEqual(scanned.map((group) => [group.sku, group.garments.length, group.models.length]))
    expect(view.groups.find((group) => group.sku === 'EF2')!.defaults).toMatchObject({ swap: 'outfit', referenceSource: 'originals', references: [{ file: '服装/EF2/g1.jpg' }] })
  })

  it('guards uploads with token, origin and size', async () => {
    const root = await materialsRoot()
    const { server } = await start(root)
    const jpg = await fixtureImageBytes(40)
    const noToken = await fetch(`${server.origin}/api/upload?sku=EX1&kind=garment&name=a.jpg`, { method: 'POST', headers: { origin: server.origin, 'content-type': 'image/jpeg' }, body: jpg })
    expect(noToken.status).toBe(401)
    expect((await upload(server, 'sku=EX1&kind=garment&name=a.jpg', jpg, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await upload(server, 'sku=EX1&kind=garment&name=a.jpg', jpg, { 'content-type': 'text/plain' })).status).toBe(415)

    // 只发头不发完整请求体：服务按 content-length 直接拒绝
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${server.origin}/api/upload?sku=EX1&kind=garment&name=big.jpg&token=${server.token}`)
      const req = httpRequest(url, { method: 'POST', headers: { origin: server.origin, 'content-type': 'image/jpeg', 'content-length': String(52_428_801) } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.write(Buffer.from(jpg))
    })
    expect(status).toBe(413)
    expect(await readdir(path.join(root, '服装/EX1'))).toEqual(['g1.jpg', 'g2.jpg'])

    const ok = await upload(server, `sku=EX1&kind=garment&name=${encodeURIComponent('新.jpg')}`, jpg, { 'content-type': 'image/jpeg' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ file: '服装/EX1/新.jpg' })
    expect((await scanSimple(root)).find((group) => group.sku === 'EX1')!.garments.map((file) => file.relativePath)).toContain('服装/EX1/新.jpg')
  })

  it('rejects bad files, path-like names and duplicate skus', async () => {
    const root = await materialsRoot()
    const { server, post } = await start(root)
    const jpg = await fixtureImageBytes(41)
    const heic = await upload(server, 'sku=EX1&kind=model&name=a.heic', jpg)
    expect(heic.status).toBe(400)
    expect(await heic.json()).toMatchObject({ error: { message: 'a.heic：只支持 jpg、png、webp' } })
    const traversal = await upload(server, `sku=EX1&kind=model&name=${encodeURIComponent('../x.jpg')}`, jpg)
    expect(traversal.status).toBe(400)
    expect(await readdir(path.dirname(root))).not.toContain('x.jpg')
    expect(await readdir(path.join(root, '模特'))).toEqual(['EF2', 'EX1'])
    const badSku = await upload(server, `sku=${encodeURIComponent('a/b')}&kind=model&name=m.jpg`, jpg)
    expect(badSku.status).toBe(400)

    const duplicate = await post('/api/sku', { sku: 'EX1' })
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ error: { message: '款号已存在：EX1' } })
    const fresh = await post('/api/sku', { sku: ' NEW1 ' })
    expect(await fresh.json()).toEqual({ sku: 'NEW1' })
    // 成图/_runs/ 里是编辑服务会话文件；新款没放图，不建目录
    expect((await readdir(root)).filter((name) => name !== '成图').sort()).toEqual(['服装', '模特'])
  })

  it('starts a new run from the page and refuses a second while busy', async () => {
    const root = await materialsRoot()
    const { server, post } = await start(root, { delayMs: 800 })
    const response = await post('/api/new-run', { groups: { EF2: { models: ['模特/EF2/m1.jpg'] } } })
    expect(response.status).toBe(200)
    const run = await response.json() as { runId: string; url: string; derivedFrom: string | null; counts: { planned: number } }
    pids.push((await readRunRecord(path.join(runsDir(root), run.runId))).pid!)
    expect(run).toMatchObject({ derivedFrom: null, counts: { planned: 1 } })
    expect(run.url).toBe(editorPageUrl(server.origin, server.token, run.runId))

    const busy = await post('/api/new-run', { groups: { EX1: { models: ['模特/EX1/m1.jpg'] } } })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: { code: 'RUN_IN_PROGRESS', message: `这个素材目录正在出图：${run.runId}` } })

    await waitFinished(root, run.runId)
    const record = await readRunRecord(path.join(runsDir(root), run.runId))
    expect(record).toMatchObject({ status: 'completed', derivedFrom: null })
    expect(record.groups[0]).toMatchObject({ sku: 'EF2', referenceSource: 'originals' })
    expect(await readdir(path.join(root, '成图/EF2'))).toEqual(['m1.png'])

    const bad = await post('/api/new-run', { groups: { NO: { models: ['x.jpg'] } } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { message: '找不到款号：NO' } })
  })
})

describe('collection api', () => {
  interface OutputView { file: string; item: string | null; model: string | null; version: number; runId: string | null }
  interface View {
    rootName: string
    latestRunId: string | null
    activeRun: { runId: string; done: number; total: number } | null
    order: string[]
    redo: { delivered: string; runId: string; sku: string; model: string; item?: string; note?: string }[]
    groups: { sku: string; prefs: Record<string, unknown>; outputs: OutputView[]; inFlight: unknown[]; cropFrom: Record<string, string>; defaults: Record<string, unknown> }[]
  }

  /** sourceRoot 之后再重出一次 m1：成图/EX1/m1-v2.png 带出图记录；EF2 手放一张没有记录的成图。 */
  async function collectionRoot(): Promise<{ root: string; second: string; get: (p: string, i?: RequestInit) => Promise<Response>; post: (p: string, b: unknown, h?: Record<string, string>) => Promise<Response>; server: { origin: string; token: string } }> {
    const root = await sourceRoot()
    const started = await start(root, { delayMs: 0 })
    const response = await started.post('/api/rerun', { fromRunId: SOURCE, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }] })
    const run = await response.json() as { runId: string }
    pids.push((await readRunRecord(path.join(runsDir(root), run.runId))).pid!)
    await waitFinished(root, run.runId)
    await mkdir(path.join(root, '成图/EF2'), { recursive: true })
    await writeFile(path.join(root, '成图/EF2/手放.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toBuffer())
    return { root, second: run.runId, ...started }
  }

  const view = async (get: (p: string) => Promise<Response>): Promise<View> => await (await get('/api/collection')).json() as View

  it('lists output versions with their run records and hand-placed files', async () => {
    const { root, second, get } = await collectionRoot()
    const result = await view(get)
    expect(result).toMatchObject({ rootName: path.basename(root), latestRunId: second, activeRun: null, maxReferences: 6, engineDefault: 'fake', order: [], redo: [] })
    const ex1 = result.groups.find((group) => group.sku === 'EX1')!
    expect(ex1.outputs).toEqual([
      { file: '成图/EX1/m1.png', item: null, model: '模特/EX1/m1.jpg', ref: '裁图/EX1/01-全身-正面.jpg', refs: ['裁图/EX1/01-全身-正面.jpg'], version: 1, runId: SOURCE },
      { file: '成图/EX1/m1-v2.png', item: null, model: '模特/EX1/m1.jpg', ref: '裁图/EX1/01-全身-正面.jpg', refs: ['裁图/EX1/01-全身-正面.jpg'], version: 2, runId: second },
      { file: '成图/EX1/m2.png', item: null, model: '模特/EX1/m2.jpg', ref: '裁图/EX1/01-全身-正面.jpg', refs: ['裁图/EX1/01-全身-正面.jpg'], version: 1, runId: SOURCE },
    ])
    expect(ex1.inFlight).toEqual([])
    expect(ex1.prefs).toEqual({ pairing: 'fixedGarment', keepFrame: false, halfModels: [] })
    expect(ex1.cropFrom).toEqual({ '裁图/EX1/01-全身-正面.jpg': '服装/EX1/g1.jpg' })
    expect(ex1.defaults).toMatchObject({ swap: 'outfit', referenceSource: 'crops', references: [{ file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }] })
    const ef2 = result.groups.find((group) => group.sku === 'EF2')!
    expect(ef2.outputs).toEqual([{ file: '成图/EF2/手放.png', item: null, model: null, ref: null, refs: [], version: 1, runId: null }])
  })

  it('saves prefs and order', async () => {
    const root = await sourceRoot()
    const { get, post } = await start(root)
    const saved = await post('/api/collection/prefs', { sku: 'EX1', pairing: 'fixedModel', halfModels: ['模特/EX1/m2.jpg'] })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ prefs: { pairing: 'fixedModel', keepFrame: false, halfModels: ['模特/EX1/m2.jpg'] } })
    expect((await view(get)).groups.find((group) => group.sku === 'EX1')!.prefs).toEqual({ pairing: 'fixedModel', keepFrame: false, halfModels: ['模特/EX1/m2.jpg'] })

    const missingModel = await post('/api/collection/prefs', { sku: 'EX1', halfModels: ['模特/EX1/nope.jpg'] })
    expect(missingModel.status).toBe(400)
    expect(await missingModel.json()).toMatchObject({ error: { message: 'EX1 没有这张模特图：模特/EX1/nope.jpg' } })
    const missingSku = await post('/api/collection/prefs', { sku: 'NO', keepFrame: true })
    expect(missingSku.status).toBe(400)
    expect(await missingSku.json()).toMatchObject({ error: { message: '找不到款号：NO' } })
    expect((await post('/api/collection/prefs', { sku: 'EX1', pairing: 'other' })).status).toBe(400)

    const order = await post('/api/collection/order', { order: ['EX1', 'EF2', 'GONE'] })
    expect(await order.json()).toEqual({ order: ['EX1', 'EF2', 'GONE'] })
    expect((await view(get)).order).toEqual(['EX1', 'EF2', 'GONE'])
    expect((await post('/api/collection/order', { order: Array.from({ length: 1001 }, () => 'x') })).status).toBe(400)
    expect((await post('/api/collection/order', { order: [1] })).status).toBe(400)
    expect(await (await post('/api/collection/order', { order: [] })).json()).toEqual({ order: [] })
  })

  it('collects redo items and validates them', async () => {
    const { get, post } = await collectionRoot()
    const added = await post('/api/redo', { action: 'add', delivered: '成图/EX1/m1-v2.png' })
    expect(added.status).toBe(200)
    const list = (await added.json() as { redo: View['redo'] }).redo
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ delivered: '成图/EX1/m1-v2.png', sku: 'EX1', model: '模特/EX1/m1.jpg' })
    expect((await (await post('/api/redo', { action: 'add', delivered: '成图/EX1/m1-v2.png' })).json() as { redo: unknown[] }).redo).toHaveLength(1)

    const handPlaced = await post('/api/redo', { action: 'add', delivered: '成图/EF2/手放.png' })
    expect(handPlaced.status).toBe(400)
    expect(await handPlaced.json()).toMatchObject({ error: { message: '这张成图没有出图记录，不能加入待重出' } })
    const long = await post('/api/redo', { action: 'note', delivered: '成图/EX1/m1-v2.png', note: '长'.repeat(201) })
    expect(long.status).toBe(400)
    expect(await long.json()).toMatchObject({ error: { message: '备注不能超过 200 字' } })
    const noted = await post('/api/redo', { action: 'note', delivered: '成图/EX1/m1-v2.png', note: '腿别截' })
    expect((await noted.json() as { redo: View['redo'] }).redo[0]!.note).toBe('腿别截')
    expect((await view(get)).redo).toHaveLength(1)

    // 同一组合（款号 + 衣服 + 模特）只留一个版本：加入另一版本时替换
    const swapped = await post('/api/redo', { action: 'add', delivered: '成图/EX1/m1.png' })
    expect((await swapped.json() as { redo: View['redo'] }).redo.map((entry) => entry.delivered)).toEqual(['成图/EX1/m1.png'])

    const removed = await post('/api/redo', { action: 'remove', delivered: '成图/EX1/m1.png' })
    expect(await removed.json()).toEqual({ redo: [] })
  })

  it('reruns the redo list as one new run and clears it', async () => {
    const { root, server, get, post } = await collectionRoot()
    await post('/api/redo', { action: 'add', delivered: '成图/EX1/m2.png', note: '腿别截' })
    const response = await post('/api/redo/run', {})
    expect(response.status).toBe(200)
    const run = await response.json() as { runId: string; url: string }
    expect(run.url).toBe(editorPageUrl(server.origin, server.token, run.runId))
    const record = await readRunRecord(path.join(runsDir(root), run.runId))
    pids.push(record.pid!)
    expect(record.derivedFrom).toBeNull()
    expect(record.groups).toHaveLength(1)
    expect(record.groups[0]!.shots.map((shot) => [shot.model, shot.extraPrompt])).toEqual([['模特/EX1/m2.jpg', '腿别截']])
    expect((await view(get)).redo).toEqual([])
    await waitFinished(root, run.runId)

    // 清单空时报错；清单保留不受影响
    const empty = await post('/api/redo/run', {})
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ error: { message: '待重出是空的' } })
  })

  it('refuses redo/run while busy and keeps the list', async () => {
    const root = await sourceRoot()
    const { get, post } = await start(root, { delayMs: 800 })
    await post('/api/redo', { action: 'add', delivered: '成图/EX1/m1.png' })
    const running = await post('/api/new-run', { groups: { EF2: { models: ['模特/EF2/m1.jpg'] } } })
    const run = await running.json() as { runId: string }
    pids.push((await readRunRecord(path.join(runsDir(root), run.runId))).pid!)
    const busy = await post('/api/redo/run', {})
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: { code: 'RUN_IN_PROGRESS', message: `这个素材目录正在出图：${run.runId}` } })
    expect((await view(get)).redo).toHaveLength(1)
    const active = (await view(get)).activeRun
    expect(active).toMatchObject({ runId: run.runId, total: 1 })
    const ef2 = (await view(get)).groups.find((group) => group.sku === 'EF2')!
    expect(ef2.inFlight).toEqual([{ runId: run.runId, item: null, model: '模特/EF2/m1.jpg', state: expect.stringMatching(/^(queued|generating)$/) as unknown }])
  })

  it('rejects a fixed-model new run with two models', async () => {
    const root = await sourceRoot()
    const { post } = await start(root)
    const response = await post('/api/new-run', { groups: { EX1: { pairing: 'fixedModel', models: ['模特/EX1/m1.jpg', '模特/EX1/m2.jpg'] } } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { message: 'EX1：固定模特只能选 1 个模特' } })
  })

  it('appends the keep-frame sentence to the prompt on request', async () => {
    const root = await sourceRoot()
    const { post } = await start(root)
    const body = { references: [{ file: '服装/EX1/g1.jpg' }], swap: 'outfit' }
    const plain = (await (await post('/api/prompt', body)).json() as { prompt: string }).prompt
    const kept = (await (await post('/api/prompt', { ...body, keepFrame: true })).json() as { prompt: string }).prompt
    expect(kept).toBe(`${plain}\n保持图1的取景范围，被截掉、没拍到的身体部位不要补画。`)
  })

  it('guards the new POST routes with origin and token', async () => {
    const root = await sourceRoot()
    const { server, post } = await start(root)
    for (const route of ['/api/collection/prefs', '/api/collection/order', '/api/redo', '/api/redo/run']) {
      expect((await post(route, {}, { origin: 'http://evil.example' })).status).toBe(403)
      const noOrigin = await fetch(`${server.origin}${route}?token=${server.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(noOrigin.status).toBe(403)
      expect((await post(route, {}, { 'content-type': 'text/plain' })).status).toBe(415)
      const noToken = await fetch(`${server.origin}${route}`, { method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' }, body: '{}' })
      expect(noToken.status).toBe(401)
    }
  })

  it('serves the collection page at /materials/ and redirects / there even with runs', async () => {
    const root = await sourceRoot()
    const { get } = await start(root)
    expect((await get('/api/materials')).status).toBe(404)
    const page = await get('/materials/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    const home = await get('/', { redirect: 'manual' })
    expect(home.status).toBe(302)
    expect(home.headers.get('location')).toBe('/materials/')
  })
})

describe('project entry', () => {
  it('shows the project display name and sends /projects to the project page', async () => {
    const { startHubServer, hubPageUrl } = await import('../src/editor/hub-server.js')
    const { addProject, renameProject } = await import('../src/editor/projects.js')
    const root = await sourceRoot()
    const home = await mkdtemp(path.join(tmpdir(), 'editor-server-home-'))
    roots.push(home)
    const env = { FASHION_TRYON_HOME: home }
    const { get } = await start(root, { env })
    const projectName = async (): Promise<string> => ((await (await get('/api/collection')).json()) as { projectName: string }).projectName
    expect(await projectName()).toBe(path.basename(root))
    const { entry } = await addProject(env, root)
    await renameProject(env, entry.id, '26冬毛绒')
    expect(await projectName()).toBe('26冬毛绒')

    const hub = await startHubServer({ launch: { cliCommand: ['false'], env } })
    closers.push(() => hub.close())
    const redirect = await get('/projects', { redirect: 'manual' })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(hubPageUrl(hub.origin, hub.token))
  })
})
